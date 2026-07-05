# why this exists

## The borrowed idea

Aviation solved this problem in the 1950s. A crash investigation cannot interview the aircraft, so the aircraft carries a recorder whose only job is to survive the event with the last minutes of state intact. The recorder does not prevent anything, diagnose anything, or alert anyone. It preserves context, because context is the one thing that cannot be recovered after the fact.

Game development solved the same problem for a different audience. A kill-cam or replay system exists because "you died" is useless information and "here is exactly what happened, watch it again" is actionable. Racing games keep a rolling buffer of the last N seconds precisely so the moment worth studying is already recorded by the time anyone knows it was worth studying. The engineering pattern under both is identical: a cheap, bounded, always-on ring buffer, and a permanent snapshot taken the instant something makes the buffer's contents valuable.

`atlas-blackbox` is that pattern applied to a small infrastructure estate. A frame a minute: hardware telemetry plus every event that crossed the estate's notification bus, deploys included. On a `failure`-level event, the buffer is copied out permanently before rotation can eat it, two frames of aftermath are appended (a kill-cam shows the fall, not just the hit), and the incident seals. The Lab page then renders it exactly the way a replay system would: land on the moment of failure, scrub backwards, watch the gauges and the event stream approach it.

## What it deliberately is not

It is not log aggregation. A SIEM answers "search everything, forever"; a black box answers "the last ten minutes, always." Keeping the buffer small is not a cost compromise, it is the design: bounded storage means it can run forever untended, and a ten-minute window forces the recording to stay at the resolution where causality is visible (a deploy marker three minutes before a failure spike tells a story; ninety days of logs tell a database).

It is not alerting. Discord already knows the estate failed within seconds, via `atlas-notify`. This repo exists for the morning after, when the question is no longer "is it down" but "what was the machine doing while it went down, and what shipped just before."

## The identity bridge, stated plainly

This repo is the point where two halves of one portfolio stop being separate sections. The infrastructure half built the estate, the event bus, the telemetry, the registry. The game development half spent years on systems whose entire job is capturing and replaying state under a frame budget: intensity systems, replay buffers, the discipline of deciding what is worth sampling at what rate. `atlas-blackbox` is the second skillset pointed at the first: a replay system whose game is the infrastructure itself. That is the reason it exists as its own repo with this document in it, rather than as a feature folded quietly into something else.

The scrubbable timeline on the Lab page is the proof. Anyone can render a status dot. Rendering the ten minutes before the dot went red, second by second, with the deploy that caused it sitting visibly on the track, is what a game developer does to a DevOps problem.
