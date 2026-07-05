#!/bin/sh
# ============================================================================
# install-part3.sh :: atlas-blackbox
# Run one command at a time. Two halves: the Worker (from the new repo
# directory) and the Lab page integration (from the atlas-systems repo).
# ============================================================================

# ---- PART 3 / STEP 1 :: create the repo from this bundle -------------------
# MANUAL :: create an empty private-or-public GitHub repo named
# atlas-blackbox, then from the bundle's atlas-blackbox/ directory:

git init

git add .

git commit -m "atlas-blackbox: flight recorder for the estate"

# ---- PART 3 / STEP 2 :: secrets, at the interactive prompt only ------------
# NOTIFY_TOKEN is the same value atlas-notify already checks.
# BLACKBOX_TOKEN gates the ground-test endpoint; generate a fresh value.

wrangler secret put NOTIFY_TOKEN

wrangler secret put BLACKBOX_TOKEN

# ---- PART 3 / STEP 3 :: deploy and confirm the recorder is recording -------

wrangler deploy

curl -s "https://api.atlas-systems.uk/blackbox/_meta"

curl -s "https://api.atlas-systems.uk/blackbox/health"

# The 5-minute watchdog cron arms the alarm; the first tick lands within
# seconds of that. recording:true and a growing frame count is the pass.

curl -s "https://api.atlas-systems.uk/blackbox/status"

# ---- PART 3 / STEP 4 :: ground test -----------------------------------------
# read -s keeps the token out of shell history (bash; you are in bash).

read -r -s BLACKBOX_TOKEN

curl -s -X POST "https://api.atlas-systems.uk/blackbox/test-incident" -H "Authorization: Bearer $BLACKBOX_TOKEN" -H "Content-Type: application/json" -d '{"title":"ground test"}'

unset BLACKBOX_TOKEN

curl -s "https://api.atlas-systems.uk/blackbox/incidents"

# The drill appears with its id; fetch it and confirm frames are inside.
# Two ticks later it flips sealed:true (the aftermath frames landed).

# ---- PART 3 / STEP 5 :: Lab page integration (atlas-systems repo) ----------

cp ../atlas-blackbox/ui/blackbox-timeline.js lab/blackbox-timeline.js

cp ../atlas-blackbox/ui/blackbox-timeline.css lab/blackbox-timeline.css

# MANUAL :: paste this section into lab/index.html after the system map
# section (search for id="system-map" and place it below that section):
#
#   <section class="section bbx-section" id="blackbox">
#     <div class="smap-head">
#       <h2>Black box</h2>
#       <p class="bbx-statusline" id="blackbox-statusline">contacting recorder&#8230;</p>
#     </div>
#     <div id="blackbox-host"></div>
#   </section>

grep -c "blackbox-timeline" lab/index.html || true

sed -i 's#<link rel="stylesheet" href="/lab/system-map.css" />#<link rel="stylesheet" href="/lab/system-map.css" />\n    <link rel="stylesheet" href="/lab/blackbox-timeline.css" />#' lab/index.html

sed -i 's#<script src="/lab/live-section.js" defer></script>#<script src="/lab/live-section.js" defer></script>\n    <script src="/lab/blackbox-timeline.js" defer></script>#' lab/index.html

grep -c "blackbox-timeline" lab/index.html

# ---- PART 3 / STEP 6 :: verify before commit --------------------------------

node --check lab/blackbox-timeline.js

npx html-validate lab/index.html

# MANUAL :: serve locally, open /lab/#blackbox: the drill incident loads,
# the cursor sits on the trigger, scrubbing moves gauges and feed, replay
# plays at 30x. On the system map, atlas-blackbox appears via registry
# discovery as an orphan node until system-map.topology.js declares it;
# add it there with its real edges (specular-edge poll, notify poll,
# ATLAS_NOTIFY binding) whenever the map file is next touched.
