# Shared and multiplayer sessions

What it would take for several people to share one jsbeeb machine: send someone a link to my machine as it is
now, let people watch me play, or have two or more of us at the keyboard of the same emulated Beeb from
different browsers. A first cut of v0 is implemented (see [What v0 does today](#what-v0-does-today)); the
rest is a design to pick holes in.

**Scope to start with: a Model B (`B-DFS1.2`) and a Master, each in its default configuration, with discs but
not tapes.** A session refuses to start on anything else: tapes, the Atom, second processors, Music 5000,
Econet, the teletext adaptor, extra ROMs, a CPU multiplier and the rest can come later, one at a time, each
with its own determinism test. That takes a lot of the edges below off the critical path, and they are marked
as later where they come up.

## What we mean

Four tiers, each building on the one before and each worth having on its own.

1. **Share a snapshot.** A link that opens jsbeeb on my machine exactly as it was when I made the link. One
   upload, no live connection. Needs a snapshot complete enough to stand alone, and somewhere to keep it.
2. **Spectate.** I host; anyone with the link watches the same machine running live in their own browser. No
   video is streamed: every viewer runs their own emulator from my snapshot and replays my inputs. Needs
   determinism, an input stream, a connection between peers and late joining. Viewers can lag a fraction of a
   second behind and nobody minds.
3. **Shared keyboard.** As spectating, but everyone's key presses (and joysticks) go into the one machine, in
   lockstep. Needs an agreed order for inputs from different people, an input delay, and desync detection and
   recovery. Fine for typing, adventures, two people on one Elite, turn-based play.
4. **Netplay with latency hiding.** Rollback, so a twitchy game played over a long link still feels local.
   Everything in 3, plus cheap save and restore, re-emulation and a way to unwind audio.

## The model: deterministic lockstep from a common snapshot

Every peer runs the whole machine. They start from the same snapshot, apply the same inputs at the same
emulated cycle, and so stay identical without sending any machine state.

**Time is cycles, not milliseconds.** The session clock is the emulated cycle count. Inputs apply only at
quantum boundaries; a frame's worth of the model's clock is the obvious quantum (40,000 cycles on a 2MHz,
50Hz Beeb), and fine enough for the keyboard, which the BBC OS scans from its 100Hz interrupt. The quantum is
a fixed cycle count, not tied to the video's vsync, so it does not care what the CRTC is programmed to do. A
press and release that land in one quantum are spread over two, or the machine would never see the key.

**One sequencer orders the inputs.** Someone has to say "frame N has exactly these inputs, and no more are
coming". The proposal is a single sequencer per session: peers send their inputs as they happen, and the
sequencer stamps each with the frame it applies on (the sender's current frame plus an input delay, or the
next frame not yet committed, whichever is later) and broadcasts `commit(N, inputs)` at a fixed rate, empty
or not. Every peer runs up to the last committed frame and no further. Peers never need to hear from each
other directly, and a quiet peer costs nothing because nobody waits on it. The sequencer is the host's
browser, which is also the hub every guest connects to (see v0); the protocol does not depend on that, so a
server could take the job over later.

**Inputs are machine-level events.** A key is sent after the sender's own mapping (layouts, user remaps in
`src/keymap.js`), not as a host key code, because mapping is per-person configuration. That is more than a
matrix position: in the symbolic layout a key can force BBC SHIFT up or down while it is held (`SysVia.set`,
`src/via.js:699`), so an event carries the position and the SHIFT it forces. With two people on one matrix,
whose SHIFT wins needs a rule; the simplest is that each person's held keys are tracked separately and a
forced SHIFT applies only while that person's key is down, but that is an open question. An analogue channel
is sent as a value change. BREAK, reset, disc changes and pastes are events too.

**Pacing.** Locally the emulation loop works out how many cycles to run from `performance.now()`, capped at a
tenth of a second, and nudges itself to keep the audio buffer full (`src/web/emulation-loop.js:220`, `:277`).
In a session the same loop gets one more cap: never past the last committed frame. `setEmulationLead` runs the
CPU itself to build audio lead (`:282`), so it needs the same cap. A peer that gets ahead simply waits, which
with a few frames of committed buffer should be inaudible. One that falls behind (a commit arrived late, a slow
phone) has to catch up by running faster for a while; today a stall longer than the cap is dropped instead
(`emulatedTo` jumps to now), which a session cannot allow. Catching up must not use the speedy frame skip:
`FRAMESKIPENABLE` also gates video memory reads and the SAA5050's clocking (`src/video.js:1099`), so a peer
that skipped frames ends up with different teletext state in MODE 7.

**Late joining.** The host takes a snapshot at a committed frame boundary and sends it along with the
session's machine description; the joiner restores it, then runs flat out through the commits since. On my
desktop, Node emulates a 50Hz frame of a B running Elite in about 3ms, so catching up is quick. The host
does not pause.

**Desync detection and recovery.** Every so often (each second, say) every peer hashes its machine state at a
committed frame and sends the hash to the sequencer. The host's hash is the reference, as in RetroArch: a
peer that differs is sent a fresh snapshot from the host and rejoins as a late joiner would. If the host is
the one that went wrong (a debugger poke, say), it is still right by definition, which is one reason the
debugger is a host-only tool in a session. The hash covers the `state` of the file form (dirty disc tracks
only, not the megabytes of clean ones), and leaves out the frame-skip bit in `video.dispEnabled`, which
differs between peers for reasons of display alone.

**Is it deterministic today?** Mostly. A quick experiment, using the headless `MachineSession` with the real
video and sound chip: boot Elite on a B and on a Master, snapshot, restore into fresh machines, run with the
same key pressed and released at the same cycles, but in execute chunks of 100,000, 37,813 and 1,997 cycles.
The machine state and framebuffer came out identical in every case. So chunking does not leak, and the CPU,
VIAs, video and FDC are already a deterministic function of state plus inputs, at least on that path (it
never ran speedy). The work is in the edges.

## The major challenges

Ranked by how much they would bite.

1. **Inputs arrive on host time.** The keyboard writes straight into the system VIA when the browser event
   fires (`src/web/keyboard.js:227`), as does BREAK (`:209`) and the Mac caps lock "tap", released by a
   `setTimeout` (`:259`). Gamepad keys are polled at the start of each tick (`src/web/emulation-loop.js:224`
   into `src/web/gamepads.js:168`). All of it lands at whatever cycle the current tick happens to have
   reached. Everything has to go through one queue that applies events at frame boundaries; that is the
   central refactor and is useful without any networking.
2. **Some inputs are pulled, not pushed.** The ADC asks its source for a value when a conversion finishes
   (`src/adc.js:164`), so the gamepad, mouse-as-joystick and microphone sources are read mid-emulation. The
   system VIA reads gamepad fire buttons live (`getJoysticks`, `src/via.js:877`). These must change so the
   machine only ever sees values that came through the input queue. That refactor is after v0, which turns
   these inputs off in a session instead.
3. **Snapshots are not complete enough for a joiner.** The native snapshot leaves out:
   - the keyboard matrix and the SHIFT override state (`SysVia.snapshotState`, `src/via.js:645`), so a joiner
     arriving while a key is held sees it up;
   - sideways RAM, which lives in the ROM area and is only saved with `includeRoms` (`src/6502.js:1235`);
   - the Master's CMOS RAM, which comes from each person's `localStorage` (`src/cmos.js:43`, persisted by
     `localStoragePersistence`);
   - a paste in progress (the typist's queue) and the mouse buttons;
   - later, with the peripherals that need them: tape position (a known limitation in
     `docs/snapshot-format.md`), Music 5000 and Econet state.

   It also leaves out the framebuffer, which is only cosmetic: a joiner sees black until the next frame. With
   media by reference and dirty tracks only, a B with Elite running comes to about 25KB gzipped; a full
   in-memory snapshot with every disc track is about 190KB gzipped. Adding sideways RAM (64KB raw on a
   Master) and CMOS will grow the first figure.

4. **Wall clock leaks into the Master.** The RTC reads `Date.now()` on every access (`src/cmos.js:19`) and
   setting it stores an offset from the computer's clock (`:184`) in a module-level variable (`:16`), shared by
   every machine on the page. Two Masters read different seconds. The clock needs to be derived from emulated
   cycles (the scheduler `epoch`, already in the snapshot) plus a base time carried in the session, with the
   offset per machine and saved. The Econet file server's date call (`src/filestore.js:84`) is the same
   problem, later, with Econet.
5. **The machine must be configured identically.** `restoreSnapshot` checks only the model and co-processor
   (`src/snapshot.js:96`). CPU multiplier, `videoCyclesBatch`, Music 5000, teletext adaptor, Econet and extra
   ROMs (`?rom=`) all change behaviour. With the starting scope the session description is just the model, and a
   session refuses to start if any of these differs from the default; a joiner adopts the model the way a
   cross-model snapshot load already reloads the page as the right machine (`src/web/snapshot-ui.js:132`). Each
   option joins the description as it is supported. The emulator itself must match too: every merge to main is
   live within minutes, and a host who loaded the page this morning may be running different code from a guest
   who opened the link just now. The description carries the build (commit and build time); a guest on another
   build is refused rather than failing hash after hash, and whichever side is older is told to reload, the host
   choosing when to restart the session (a new room, and a new link to send round). Media sent by reference must
   be fetchable by everyone: `sth:` and URLs are, embedded local files are, a `gd:` Google Drive reference is not
   without the viewer's own authorisation. v0 sidesteps this by sending the images themselves.
6. **Local controls that change state.** Rewind, loading a state, the debugger, fast-as-possible and fast
   tape, hidden-tab pause (`src/web/emulation-loop.js:289`), media changes and reset all act on one peer's
   machine. In a session each either becomes a session event (reset, disc change, perhaps rewind for everyone)
   or is turned off for guests. A hidden guest tab must not stall everybody, and with a sequencer that only
   waits on time it does not. A hidden host tab is different, because the host is the sequencer: today the loop
   pauses itself when hidden, and browsers throttle timers in background tabs, so commits would stall or
   bunch for everyone and no snapshot could be taken for a joiner. In a session the host keeps running when
   hidden, and how well it can under background throttling (which also slows its rendezvous polling, so late
   joiners wait) is a cost of host-as-sequencer.
7. **Two clocks.** Each browser's audio runs on its own crystal, and in a session the emulation rate is set by
   the sequencer. Over minutes they drift, so each peer either stretches its audio slightly or skips and pads
   it. The existing emulation lead logic (`setEmulationLead`) is the place for that.
8. **Smaller ones.** The disc noise picks its clicks with `Math.random` (`src/ddnoise.js:84`), but that is
   audio only and harmless. Later, the Atom randomises some RAM on reset (`src/6502.js:1706`), so it will need a
   session-wide seed.

## Prior art

[RetroArch netplay](https://docs.libretro.com/development/retroarch/netplay/) requires the same core and
content on every peer, syncs a joiner with a savestate, rewinds and replays when late input arrives, and
has peers compare state CRCs with the host's, asking for a savestate on a mismatch.
[GGPO](https://github.com/pond3r/ggpo) (fighting games) is the reference design for rollback: predict that
remote inputs have not changed, run ahead, and on a misprediction load the last confirmed state and
re-simulate. [Dolphin's netplay](https://github.com/dolphin-emu/dolphin/blob/master/Source/Core/Core/NetPlayClient.cpp)
is lockstep with an input (pad) buffer and desync detection. All three need bit-for-bit determinism and
identical configuration. jsbeeb has the main ingredient already: snapshot and restore are cheap
(about 0.1ms and 0.2ms on my desktop, which is what makes rewind work) and the rewind thumbnails already
re-emulate from a snapshot and put the machine back (`src/web/rewind-thumbnail.js`).

## Server options

The site is static, synced to S3 on every merge to main (`.github/workflows/test-and-deploy.yml`) and served
through CloudFront. The emulator never runs on a server. Traffic is small: inputs are a few bytes each,
commits at 25 a second (every other frame) to four guests are 100 messages a second out of the host, plus a
hash per guest per second, and a snapshot is tens of KB once per join.

| Option                                    | Good                                                          | Bad                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| WebRTC data channels, rendezvous only     | Peer to peer, lowest latency; the server sees a few KB a join | NAT traversal: STUN, and TURN for the unlucky; more client code                                                |
| API Gateway WebSocket + Lambda + DynamoDB | Same AWS account as the site; nothing to run; free when idle  | Every message is a Lambda invocation, a DynamoDB lookup and a post per peer; two-hour and idle connection cuts |
| Cloudflare Durable Objects                | One object per room holds the sockets and a timer             | Another provider, account and deployment                                                                       |
| Small always-on box running a relay       | Simplest relay; flat cost                                     | A server to keep patched and up; one region                                                                    |

The recommendation is WebRTC with the host as hub and sequencer, and a small Lambda for rendezvous only (see
v0). The protocol stays transport-agnostic: the session code talks to a channel, so the tests can run two
or more headless machines exchanging messages in-process with no server at all, and a local stand-in for the
rendezvous endpoint is enough to try two browsers on one machine. If too many people cannot connect
directly, a hosted TURN service is the next step, and one of the relays above is the fallback after that.

## v0

The smallest session worth having, on the machines in the scope above: spectating first, then a shared
keyboard. Snapshot links (tier 1) can come separately.

- **Inputs:** the BBC keyboard and BREAK, nothing else. The ADC and everything on it (analogue joysticks,
  gamepad analogue, mouse-as-joystick, the microphone), gamepads altogether (including buttons mapped to
  keys, and the fire buttons the system VIA reads live) and the mouse buttons are off in a session: the
  host cannot start one with them selected, and a guest's are disabled while it is joined. Guests send keys
  only; BREAK, reset and disc changes are session events from the host alone until what a guest may do is
  settled; a disc change carries the image. Pasting, rewind, loading a state, fast-as-possible and the
  debugger are off for everyone.
- **The Master's RTC:** in a session only, derived from emulated cycles as challenge 4 describes, with the time
  the host's Master shows at session start, less its epoch then, as the base in the session description, so
  everyone sees the same, roughly real, time. Outside a session it keeps the computer's own clock. The `Cmos` is
  built before the CPU that owns the scheduler (`src/6502.js:635`), so the clock is wired in afterwards; it
  touches `src/cmos.js`, `src/6502.js` and the two places a `Cmos` is made (`src/web/machine.js:77`,
  `src/machine-spec.js:56`).
- **Transport:** WebRTC data channels in a star. Each guest connects to the host only; the host orders inputs and
  broadcasts commits over a reliable, ordered channel (the default). A joiner's snapshot is the full in-memory
  form, discs included, sent chunked over the same channel, so local and `gd:` discs need no fetching by the
  guest. Public STUN (Google's, say) and no TURN: a guest that cannot connect is told "couldn't connect
  directly", and we count how often that happens before paying for anything. The host and each guest see each
  other's public IP address, which the share UI says. The session ends when the host leaves, and each guest's
  machine carries on as a local one, back on its own computer's clock. A guest never saves the session's CMOS
  over its own stored settings, during the session or after it, and checks what it receives as it would a loaded
  file (size, model); the host accepts only key events, state hashes and resync requests from a guest.
- **Rendezvous:** one small AWS Lambda with a function URL, added to the existing bbc.xania.org CloudFront
  distribution as a second origin at `/api/rendezvous/*` with caching disabled, so it is same-origin with the
  page and needs no CORS. A DynamoDB table with a TTL holds each room's offers and answers. The host creates the
  room under a random, unguessable ID, which goes in the share link, and gets back a host secret that never
  leaves its tab. A guest opening the link creates an offer, waits for ICE gathering to finish (or a short
  timeout) so the full SDP goes in one message, POSTs it under an ID of its own, and polls for its answer, giving
  up with "the host isn't answering" after a while. The host polls the room every second or two, answers each new
  offer under that guest's ID, and keeps polling slowly for the life of the session, for late joiners. Listing
  offers, answering and extending the room's TTL need the host secret; a guest can only post its offer and read
  its answer, so no guest sees another's address or can answer in the host's place. The host deletes the room
  when it leaves, if it can, and TTL catches the rest; an offer to a missing or expired room is refused, so a
  stale link says the session is over. The function treats anything past its expiry as gone, since DynamoDB
  deletes lazily, checks the shape of IDs, caps body size and pending offers per room, and stores nothing but
  SDP. Each offer has its own short expiry, independent of the room's, and its answer stays readable until
  then, so a guest that closes its tab while waiting cannot fill the cap, and one whose read was lost can
  retry. Open tabs outlive a deploy, so the API
  stays backward compatible.
- **Infrastructure:** already in place, in
  [godbolt-terraform](https://github.com/mattgodbolt/godbolt-terraform): the function (Node 22, arm64), its
  table, role and log group in `new/jsbeeb-rendezvous.tf`, and `/api/rendezvous/*` on the bbc.xania.org
  distribution through `api_origins` on `module "jsbeeb"` (`new/jsbeeb.tf`, built in `new/website/main.tf`).
  It answers 503 from a placeholder today. Terraform owns the function's shape and ignores its code. The code
  lives in this repo under `rendezvous/` and ships with the site: `deploy-jsbeeb` may `UpdateFunctionCode` and
  `GetFunction` on that one function, so the deploy job runs `aws lambda update-function-code` then
  `aws lambda wait function-updated-v2` before the S3 sync, as it already uploads assets before the HTML that
  names them.
- **Voice:** not in v0; use a separate call (Zoom, Discord, whatever people already have).

### What v0 does today

To try it: one person opens jsbeeb with `?server=<room>` added to whatever else they want (a disc, a model,
`autoboot`), and everyone else opens `?client=<room>`. A guest on a different model reloads as the host's
before it joins. Locally, `npm start` serves the rendezvous from memory, so two browser windows on one machine
make a session with no AWS involved.

- `src/lockstep.js` is the protocol, with no browser in it. The host applies queued inputs at the cycle it has
  reached between two executes and commits `{at, inputs, upTo}`, with a state hash (registers, RAM and the
  keyboard matrix) every emulated second. A guest replays to exactly those cycles, which are instruction
  boundaries, so it stops where the host stopped whatever slices its own loop runs in. There is no fixed
  quantum and no input delay: a host's key applies at its next tick, a guest's at the host's next tick after it
  arrives, and guests trail the host by the network's latency. `tests/integration/lockstep.js` runs a host and
  guests in-process through delays and uneven slices, with a late joiner, a Master's clock and a forced desync.
- `src/web/shared-session.js` is the browser side: the rendezvous, WebRTC, the snapshot sent to a joiner
  (`snapshotState({ includeRoms: true })`, gzipped and chunked, which carries discs and sideways RAM), resync on
  a hash mismatch, and goodbyes. `tests/playwright/shared-session.spec.js` runs a host and a guest in two
  browser contexts and types on both.
- The loop takes a session's `execute` in place of the processor's, and the keyboard sends keys and BREAK to the
  session, mapped to the matrix with the sender's layout. A joiner is sent the host's held keys beside the
  snapshot (snapshots themselves still leave them out, so rewind keeps the keys you are holding); a session's
  Masters share the host's CMOS settings, its clock offset, and a clock driven by emulated cycles that starts
  again from the real time whenever the host jumps.
- `rendezvous/` is deployed and answers at `bbc.xania.org/api/rendezvous`; CI updates it before the site.

Known gaps, all left for after a first play:

- Nothing refuses an unsupported configuration beyond the Atom and a second processor; the version check is
  the package version, not a build.
- Anything that changes a machine without going through the session (pasting, the reset menu, rewind, loading
  a state, the debugger, changing a disc) is not blocked. On the host, one that moves the cycle count (a hard
  reset, rewind, a loaded state) resyncs every guest at once; anything else makes guests fail their next hash
  and be resynced from the host within a second or so. On a guest it is undone the same way.
- Inputs the machine reads for itself rather than being sent (the ADC's sources, the gamepad fire buttons the
  system VIA reads) are not blocked either, and desync a session the same way if used.
- A guest's BREAK is ignored, and a guest that leaves has its held keys let go on every machine.
- A guest's own page still shows its own drives in the front panel and media window.
- A Master host's own `*CONFIGURE` changes made during a session are not saved, since its CMOS is the
  session's; a guest gets its own settings and clock back when it leaves.
- When a guest leaves, the keys it held are let go even if someone else is holding the same key.
- A hidden host tab no longer pauses, but its timers are throttled by the browser, so guests stutter.
- A host that reloads keeps `?server=` in its URL; the room is deleted as the page goes, but if that is lost
  the reload is refused until the room expires, and a new name is the way out.

In order, each a PR (the first cut above does most of 1 to 7 in one go):

1. **A determinism test.** An integration test that boots a B and a Master with a disc, snapshots, then runs
   several fresh machines from that snapshot with the same recorded input log (including a hard reset) in
   different chunk sizes, and compares state hashes and framebuffers, as the experiment above did. Adds a
   `stateHash` helper.
2. **One keyboard queue.** Keyboard, BREAK and the Mac caps lock tap go through a cycle-stamped queue applied
   at quantum boundaries. Touches `src/web/keyboard.js` and `src/web/emulation-loop.js`. Keys gain up to one
   quantum of latency, and a tap shorter than a quantum is held for one; otherwise nothing visible changes.
3. **Close the snapshot gaps.** Keyboard matrix and SHIFT override state, sideways RAM, CMOS contents, and the
   cycle-driven RTC. Touches `src/via.js`, `src/6502.js`, `src/cmos.js`, `src/snapshot.js` and
   `docs/snapshot-format.md` (a version bump; older snapshots restore with no keys down and the stored CMOS).
   The step 1 test grows to cover a mid-keypress snapshot.
4. **The session protocol, in-process.** Commits, inputs, hashes and chunked snapshots over an abstract
   channel; the pacing cap at the last committed frame; the session's machine and input checks, and a build ID
   (the commit and build time, which nothing records today). Tested with two or more headless machines
   talking in-process, with a late joiner and a forced desync.
5. **Rendezvous.** The Lambda's code in `rendezvous/` with its tests, and the deploy step.
6. **Spectating** (tier 2). WebRTC, late joining and desync recovery, behind hidden URL switches
   (`?server=<id>` to host, `?client=<id>` to join) with no UI, so we can try it with friends before
   designing the share UI. For now the host picks `<id>` and sends the link round itself; creating a room
   that already exists is refused, and a guessable ID is accepted only while testing (the UI will generate
   them). The switches stay in the URL, so a reloaded host tries to create the room again without its secret
   and is refused until the old room expires; picking a new ID is the way out. Guests cannot type yet.
7. **Shared keyboard** (tier 3). Guests' keys go through the host, with an input delay. The first target
   is [Scorched Earth](https://github.com/mattgodbolt/beeb-scorched-earth): a B, keyboard only, turn-based
   and hot-seat for two to six, so input delay barely matters and a shared keyboard is how it is meant to be
   played.

After v0, in no fixed order: record and replay (a snapshot plus input log, which is spectating from a file);
snapshot links; the pulled inputs (ADC sources, gamepads, the mouse) through the queue, with `src/adc.js`, the
sources and `getJoysticks` reading only what came through it; the other configuration options one at a time;
TURN; voice (below); and rollback (tier 4), only if tier 3 feels too laggy, which also needs painting suppressed
during re-emulation and the sound chip's queued events unwound.

### Voice, later

WebRTC carries audio as readily as data, so voice in the session is mostly UI:

- `getUserMedia` with the browser's echo cancellation and noise suppression, and the track added to the
  peer connection the session already has. Adding a track needs a renegotiation, but the offer and answer can
  go over the data channel, so the rendezvous is not involved; the host's whitelist of guest messages grows to
  take them. The audio is Opus, and the browser handles
  jitter.
- Bidirectional between the host and one guest is just each adding its track. With more guests, the star
  means guests only hear the host unless the host forwards each guest's track to the others (a received
  track can be added to another connection), which is fine for a handful; a mesh of audio-only connections
  is the alternative.
- Microphone off by default, a mute button, and a permission prompt only when someone turns it on.
- The browser's echo cancellation may not remove the emulator's own sound, which plays through Web Audio
  rather than WebRTC, so headphones may be needed. Untested.
- Without TURN, voice fails exactly when the session does, so it adds no new connection problem.

## Open questions

- How SHIFT is shared when two people hold keys that force it different ways.
- How much input delay is right by default, and whether a session should choose it from measured latency.
- What a guest may do: type only, or also press BREAK, reset, change discs, rewind for everyone.
- Where shared snapshots live (S3 behind a small upload endpoint, a gist, the user's Google Drive), for how
  long, and whether that is acceptable given a snapshot holds whatever was in RAM.
- Whether the Electron app should be able to host. It loads the page from a file (`src/app/app.js:71`), so
  it would need the rendezvous URL in full and the function would need CORS.
- Whether TURN is needed, once we know how often direct connections fail, and which hosted service.
- Whether the jsbeeb-specific Terraform should move into this repo.

---

This design was drafted by Claude (an LLM) with Matt.
