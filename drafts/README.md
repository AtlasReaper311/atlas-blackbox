# drafts/
 
Postmortem drafts opened via pull request (typically by Ramone, using the
GitHub tool's write_file + create_pull_request methods). A workflow
triggered on pull requests touching this folder runs
scripts/render-draft.mjs automatically and pushes the converted output
back onto the same PR branch, so the PR already contains both the source
markdown here and the resulting postmortems/*.html + manifest.json entry
by the time it's reviewed.
 
Nothing here is live. The only thing that ships this to production is
merging the PR into main, same as any other change to this repo.
 
Locally-authored drafts (atlas-postmortem's own output, reviewed by hand)
use a different, unrelated path: scripts/publish-postmortem.mjs, run
directly against files in atlas-postmortems/, not this folder.
