#!/usr/bin/env bash
# Act on GitHub as the maintainer App bot (xbankov-ai-maintainer[bot]) for
# this repository. The token is minted per call and kept in memory only.
#
#   scripts/bot-pr.sh push <branch>
#   scripts/bot-pr.sh open <branch> <title> <body-file>      -> prints PR number
#   scripts/bot-pr.sh wait <pr> [minutes]                    -> waits for Sourcery's review of the PR head
#   scripts/bot-pr.sh threads <pr>                           -> unresolved review threads
#   scripts/bot-pr.sh reply <thread-id> <body-file>          -> reply, then resolve the thread
#   scripts/bot-pr.sh comment <pr> <body-file>               -> PR conversation comment
set -euo pipefail
REPO="xbankov/ai-github-maintainer"
cd "$(dirname "$0")/.."

GH_TOKEN="$(npx tsx scripts/github-app-token.ts "$REPO" 2>/dev/null)" || { echo "cannot mint App token" >&2; exit 1; }
export GH_TOKEN

cmd="${1:-}"; shift || true
case "$cmd" in
  push)
    branch="$1"
    [ "$branch" = "main" ] && { echo "refusing to push main" >&2; exit 1; }
    b64="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
    GIT_CONFIG_COUNT=2 \
      GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $b64" \
      GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= GIT_TERMINAL_PROMPT=0 \
      git push -u origin "$branch" 2>&1 | grep -vi authorization
    ;;
  open)
    branch="$1"; title="$2"; body="$3"
    gh pr create -R "$REPO" --base main --head "$branch" --title "$title" --body-file "$body" | grep -oE '[0-9]+$'
    ;;
  wait)
    pr="$1"; minutes="${2:-20}"
    head="$(gh api "repos/$REPO/pulls/$pr" --jq .head.sha)"
    for _ in $(seq 1 $((minutes * 2))); do
      n="$(gh api "repos/$REPO/pulls/$pr/reviews" --jq "[.[] | select(.user.login==\"sourcery-ai[bot]\" and .commit_id==\"$head\")] | length")"
      [ "$n" -gt 0 ] && { echo "Sourcery reviewed ${head:0:7}"; exit 0; }
      sleep 30
    done
    echo "no Sourcery review of ${head:0:7} after $minutes min" >&2; exit 2
    ;;
  threads)
    pr="$1"
    gh api graphql -F pr="$pr" -f query='query($pr:Int!){repository(owner:"xbankov",name:"ai-github-maintainer"){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved path line comments(first:1){nodes{author{login} body}}}}}}}' \
      --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | "### \(.id) \(.path):\(.line) (\(.comments.nodes[0].author.login))\n\(.comments.nodes[0].body)\n"'
    ;;
  reply)
    thread="$1"; body="$(cat "$2")"
    gh api graphql -f t="$thread" -f b="$body" -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' >/dev/null
    gh api graphql -f t="$thread" -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' --jq '.data.resolveReviewThread.thread.isResolved'
    ;;
  comment)
    gh pr comment -R "$REPO" "$1" --body-file "$2" >/dev/null && echo commented
    ;;
  *)
    sed -n '2,12p' "$0"; exit 2
    ;;
esac
