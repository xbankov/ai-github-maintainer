#!/usr/bin/env bash
# Act on GitHub as the maintainer App bot (xbankov-ai-maintainer[bot]) for
# this repository. The token is minted per call and kept in memory only.
#
#   scripts/bot-pr.sh push <branch>
#   scripts/bot-pr.sh open <branch> <title> <body-file>      -> prints PR number
#   scripts/bot-pr.sh wait <pr> [minutes]                    -> waits for Sourcery's review of the current PR head
#   scripts/bot-pr.sh threads <pr>                           -> unresolved review threads (all comments)
#   scripts/bot-pr.sh reply <thread-id> <body-file>          -> reply (once), then resolve the thread
#   scripts/bot-pr.sh comment <pr> <body-file>               -> PR conversation comment (once)
set -euo pipefail
REPO="xbankov/ai-github-maintainer"
OWNER="${REPO%/*}"
NAME="${REPO#*/}"
BOT="xbankov-ai-maintainer"
cd "$(dirname "$0")/.."

GH_TOKEN="$(npx tsx scripts/github-app-token.ts "$REPO" 2>/dev/null)" || {
  echo "cannot mint App token" >&2
  exit 1
}
export GH_TOKEN

# gh api with bounded retries for transient failures.
api() {
  local attempt
  for attempt in 1 2 3 4; do
    if gh api "$@"; then return 0; fi
    [ "$attempt" -lt 4 ] && sleep $((attempt * 5))
  done
  return 1
}

# JSON string literal of $1 (for exact comparisons in --jq filters).
json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1"
}

usage() {
  sed -n '2,10p' "$0"
  exit 2
}

cmd="${1:-}"
shift || true
case "$cmd" in
  push)
    branch="${1:-}"
    # Only plain branch names; never main/master, refspecs or full refs.
    if ! [[ "$branch" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] ||
      [[ "$branch" == "main" || "$branch" == "master" || "$branch" == *..* ]]; then
      echo "refusing to push '$branch'" >&2
      exit 1
    fi
    b64="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
    # Explicit HTTPS URL, so the App token is used even if origin is an SSH remote.
    GIT_CONFIG_COUNT=2 \
      GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $b64" \
      GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= GIT_TERMINAL_PROMPT=0 \
      git push "https://github.com/$REPO.git" "refs/heads/$branch:refs/heads/$branch" 2>&1 |
      grep -vi authorization || true
    git branch --set-upstream-to="origin/$branch" "$branch" >/dev/null 2>&1 || true
    ;;

  open)
    [ $# -eq 3 ] || usage
    gh pr create -R "$REPO" --base main --head "$1" --title "$2" --body-file "$3" | grep -oE '[0-9]+$'
    ;;

  wait)
    pr="${1:-}"
    minutes="${2:-20}"
    [[ "$pr" =~ ^[0-9]+$ ]] || usage
    [[ "$minutes" =~ ^[0-9]{1,3}$ ]] || {
      echo "minutes must be a number (1-999)" >&2
      exit 2
    }
    deadline=$(($(date +%s) + minutes * 60))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      # Always compare with the current head: a new push needs a new review.
      if head="$(api "repos/$REPO/pulls/$pr" --jq .head.sha 2>/dev/null)" &&
        n="$(api --paginate "repos/$REPO/pulls/$pr/reviews" \
          --jq "[.[] | select(.user.login==\"sourcery-ai[bot]\" and .commit_id==\"$head\")] | length" 2>/dev/null |
          awk '{s+=$1} END {print s+0}')"; then
        if [ "$n" -gt 0 ]; then
          echo "Sourcery reviewed ${head:0:7}"
          exit 0
        fi
      fi
      sleep 30
    done
    echo "no Sourcery review of the current head after $minutes min" >&2
    exit 3
    ;;

  threads)
    pr="${1:-}"
    [[ "$pr" =~ ^[0-9]+$ ]] || usage
    api graphql --paginate -F owner="$OWNER" -F name="$NAME" -F pr="$pr" -f query='
      query($owner:String!, $name:String!, $pr:Int!, $endCursor:String) {
        repository(owner:$owner, name:$name) { pullRequest(number:$pr) {
          reviewThreads(first:100, after:$endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved path line
              comments(first:100) { nodes { author { login } body } } } } } } }' \
      --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) |
        "### \(.id) \(.path):\(.line)\n" + ([.comments.nodes[] | "--- \(.author.login):\n\(.body)"] | join("\n")) + "\n"'
    ;;

  reply)
    thread="${1:-}"
    [ -n "$thread" ] && [ -f "${2:-}" ] || usage
    body="$(cat "$2")"
    # Do not post the same reply twice (e.g. when a previous run failed while resolving).
    already="$(api graphql -f t="$thread" -f query='query($t:ID!){node(id:$t){... on PullRequestReviewThread{comments(last:100){nodes{author{login} body}}}}}' \
      --jq "[.data.node.comments.nodes[] | select(.author.login==\"$BOT\" and .body==$(json_string "$body"))] | length")"
    if [ "$already" -eq 0 ]; then
      api graphql -f t="$thread" -f b="$body" -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' >/dev/null
    fi
    api graphql -f t="$thread" -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
      --jq '.data.resolveReviewThread.thread.isResolved'
    ;;

  comment)
    pr="${1:-}"
    [[ "$pr" =~ ^[0-9]+$ ]] && [ -f "${2:-}" ] || usage
    body="$(cat "$2")"
    already="$(api --paginate "repos/$REPO/issues/$pr/comments" \
      --jq "[.[] | select(.user.login==\"$BOT[bot]\" and .body==$(json_string "$body"))] | length" |
      awk '{s+=$1} END {print s+0}')"
    if [ "$already" -eq 0 ]; then
      gh pr comment -R "$REPO" "$pr" --body-file "$2" >/dev/null
      echo commented
    else
      echo "already commented"
    fi
    ;;

  *) usage ;;
esac
