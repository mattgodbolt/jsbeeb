# Shared and multiplayer sessions

What it would take for several people to share one jsbeeb machine: send someone a link to my machine as it is
now, let people watch me play, or have two or more of us at the keyboard of the same emulated Beeb from
different browsers. A first cut of [v0](#v0) is built (`src/lockstep.js`, `rendezvous/` and
`src/web/shared-session.js`); the rest is a design to pick holes in.

**Scope to start with: a Model B (`B-DFS1.2`) and a Master, each in its default configuration, with discs but
not tapes.** A session should refuse to start on anything else (v0 refuses only the Atom and second
processors so far): tapes, Music 5000, Econet, the teletext adaptor, extra ROMs, a CPU multiplier and the rest
can come later, one at a time, each with its own determinism test. That takes a lot of the edges below off the
critical path, and they are marked as later where they come up.

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

**Time is cycles, not milliseconds.** The session clock is the emulated cycle count, and every input is stamped
with the cycle it applies at. In v0 that is wherever the host's machine had got to between two executes,
which is always an instruction boundary, so any machine running the same code stops there exactly, whatever
slices its own loop runs in. The host applies a guest's keys at least 40ms apart (see Known gaps), so a fixed
quantum is not needed to keep a tap from landing on one cycle.

**One sequencer orders the inputs.** The host is the sequencer. Guests send it their inputs as they happen; it
applies them at its next execute (a guest's keys no closer than 40ms apart) and sends every guest a commit, `{at, inputs, upTo}`: the inputs it applied at
cycle `at`, and how far it then ran. A guest runs up to the last commit and no further. Guests never hear from
each other, and a quiet guest costs nothing because nobody waits on it. The host is also the hub every guest
connects to (see v0); the protocol does not depend on that, so a server could take the job over later.

**Inputs are machine-level events.** A key is sent after the sender's own mapping (layouts, user remaps in
`src/keymap.js`), not as a host key code, because mapping is per-person configuration. That is more than a
matrix position: in the symbolic layout a key can force BBC SHIFT up or down while it is held (`SysVia.setMapped`),
so an event carries the position and the SHIFT it forces. With two people on one matrix, whose SHIFT wins needs
a rule; the simplest is that each person's held keys are tracked separately and a forced SHIFT applies only
while that person's key is down, but that is an open question. An analogue channel would be sent as a value
change, and reset, disc changes and pastes would be events too; in v0 only keys and the host's BREAK are.

**Pacing.** The emulation loop works out how many cycles to run from `performance.now()`, capped at a tenth of
a second, and nudges itself to keep the audio buffer full (`EmulationLoop.advance` and `setEmulationLead`). In a
session the host runs as before. A guest runs what its loop asks but never past the host's last commit, and
when it is more than a quarter of a second behind it runs faster, by at most a tenth of a second at a time. A
guest left waiting for commits does not get that time back, so on a jittery link it settles up to a quarter of
a second behind the host, on top of the network's latency. Catching up must not use the speedy frame skip:
`FRAMESKIPENABLE` also gates video memory reads and the SAA5050's clocking (`src/video.js:1099`), so a peer that
skipped frames would end up with different teletext state in MODE 7. A session never runs speedy.

**Late joining.** The host takes a snapshot where its next commit will start, and sends it with what ordinary
snapshots leave out: the ROMs and sideways RAM, the keys held down and the CMOS. Commits made
while it is being compressed wait for it. On my desktop, Node emulates a 50Hz frame of a B running Elite in
about 3ms, so catching up is quick. The host does not pause.

**Desync detection and recovery.** Every emulated second the host puts a hash of its registers, RAM and
keyboard matrix in a commit, and each guest compares its own at the same cycle. A guest that differs, finds a
gap in the commits, or finds its own machine somewhere other than where it left it, asks the host for a fresh
snapshot and rejoins as a late joiner would. The host is the reference, as in RetroArch: if the host is the one
that went wrong (a debugger poke, say), it is still right by definition. A host whose own cycle count jumps (a
hard reset, rewind, a loaded state) resyncs every guest at once, since nobody can replay across that.

**Is it deterministic today?** Mostly. A quick experiment, using the headless `MachineSession` with the real
video and sound chip: boot Elite on a B and on a Master, snapshot, restore into fresh machines, run with the
same key pressed and released at the same cycles, but in execute chunks of 100,000, 37,813 and 1,997 cycles.
The machine state and framebuffer came out identical in every case. So chunking does not leak, and the CPU,
VIAs, video and FDC are already a deterministic function of state plus inputs, at least on that path (it
never ran speedy). The work is in the edges.

## The major challenges

Ranked by how much they would bite.

1. **Inputs arrive on host time.** The keyboard writes straight into the system VIA when the browser event
   fires (`Keyboard._press`), as does BREAK, and the Mac caps lock "tap" is released by a `setTimeout`
   (`Keyboard.handleMacCapsLock`). Gamepad keys are polled at the start of each tick (`EmulationLoop.advance`
   into `src/web/gamepads.js:168`). All of it lands at whatever cycle the current tick happens to have reached.
   In v0, keys, BREAK and the caps lock tap go through the session instead (`Keyboard.setInput`), which stamps
   each with a cycle, and gamepad keys are not polled while a session runs.
2. **Some inputs are pulled, not pushed.** The ADC asks its source for a value when a conversion finishes
   (`Adc.onComplete`), so the gamepad, mouse-as-joystick and microphone sources are read mid-emulation, and the
   OS converts continuously into RAM whether a program reads them or not. The system VIA reads gamepad fire
   buttons live (`SysVia.getJoysticks`). These must change so the machine only ever sees values that came
   through the session. That refactor is after v0, which holds every ADC channel at its centre in a session and
   does not yet block the fire buttons (see the gaps).
3. **Snapshots are not complete enough for a joiner.** The native snapshot leaves out:
   - the keyboard matrix and the SHIFT override state (`SysVia.snapshotState`), so a joiner arriving while a
     key is held sees it up;
   - sideways RAM, which lives in the ROM area and is only saved with `includeRoms` (`src/6502.js:1235`);
   - the Master's CMOS RAM, which comes from each person's `localStorage` (persisted by `localStoragePersistence`);
   - a paste in progress (the typist's queue) and the mouse buttons;
   - later, with the peripherals that need them: tape position (a known limitation in
     `docs/snapshot-format.md`), Music 5000 and Econet state.

   It also leaves out the framebuffer, which is only cosmetic: a joiner sees black until the next frame. With
   media by reference and dirty tracks only, a B with Elite running comes to about 25KB gzipped; a full
   in-memory snapshot with every disc track is about 190KB gzipped. v0 sends the in-memory form with sideways
   RAM (`includeRoms`), and the held keys and CMOS beside it, and leaves the snapshot format alone, so a rewind
   or a loaded state keeps the keys the person is actually holding.

4. **Wall clock leaks into the Master.** The RTC read `Date.now()` on every access, and kept the offset a
   program set it to in one module-level variable shared by every machine on the page, so two Masters read
   different seconds. v0 makes the offset per machine (`Cmos.timeOffset`) and, in a session, reads the clock as
   a base time the host sends plus the emulated cycles (`Cmos.joinSession`). The Econet file server's date call
   (`src/filestore.js:84`) is the same problem, later, with Econet.
5. **The machine must be configured identically.** `restoreSnapshot` checks only the model and co-processor
   (`src/snapshot.js:96`). CPU multiplier, `videoCyclesBatch`, Music 5000, teletext adaptor, Econet and extra
   ROMs (`?rom=`) all change behaviour. With the starting scope the session description is just the model, and a
   session refuses to start if any of these differs from the default; a joiner adopts the model the way a
   cross-model snapshot load already reloads the page as the right machine (`src/web/snapshot-ui.js:132`). Each
   option joins the description as it is supported. The emulator itself must match too: every merge to main is
   live within minutes, and a host who loaded the page this morning may be running different code from a guest
   who opened the link just now. The description should carry the build (commit and build time); a guest on
   another build is refused rather than failing hash after hash, and whichever side is older is told to reload,
   the host choosing when to restart the session (a new room, and a new link to send round). v0 checks the
   package version instead, and refuses only the Atom and second processors so far. Media sent by reference must
   be fetchable by everyone: `sth:` and URLs are, embedded local files are, a `gd:` Google Drive reference is not
   without the viewer's own authorisation. v0 sidesteps this by sending the images themselves.
6. **Local controls that change state.** Rewind, loading a state, the debugger, fast-as-possible and fast
   tape, hidden-tab pause (`EmulationLoop.handleVisibilityChange`), media changes and reset all act on one peer's
   machine. In a session each either becomes a session event (reset, disc change, perhaps rewind for everyone)
   or is turned off for guests. A hidden guest tab must not stall everybody, and with a sequencer that only
   waits on time it does not. A hidden host tab is different, because the host is the sequencer: today the loop
   pauses itself when hidden, and browsers throttle timers in background tabs, so commits would stall or
   bunch for everyone and no snapshot could be taken for a joiner. In a session the host keeps running when
   hidden, but a hidden tab's timers fire about once a second and each tick is capped at a tenth of a second,
   so a silent hidden host should run the session at about a tenth of real speed (a tab playing sound is
   exempt; not measured), and its rendezvous polling slows too. That is the cost of host-as-sequencer.
7. **Two clocks.** Each browser's audio runs on its own crystal, and in a session the emulation rate is set by
   the sequencer. Over minutes they drift, so each peer either stretches its audio slightly or skips and pads
   it. The existing emulation lead logic (`setEmulationLead`) is the place for that. In v0 a guest simply runs
   no faster than the host's commits and catches up when more than a quarter of a second behind (see
   Pacing), so its audio stalls or races a little rather than drifting.
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
through CloudFront. The emulator never runs on a server. Traffic is small but frequent: inputs are a few bytes
each, v0 sends a commit for every execute, about 160 a second to each guest at 60Hz, each a few dozen bytes,
and a snapshot of a few hundred KB once per join. Any option that charges per message pays for every commit.

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

The smallest session worth having, on the machines in the scope above, built in `src/lockstep.js` (the
protocol, with no browser in it), `rendezvous/` and `src/web/shared-session.js`. `?server=<room>` hosts and
`?client=<room>` joins. There is no share UI yet, so the host picks the room's name and sends the link round
itself. To try it: `npm start`, then the host's URL with whatever else you want (a disc, a model, `autoboot`) in
one window and the guest's in another, side by side rather than as tabs. The first target is
[Scorched Earth](https://github.com/mattgodbolt/beeb-scorched-earth): a B, keyboard only, turn-based and hot-seat
for two to six, so lag barely matters and a shared keyboard is how it is meant to be played.

- **Inputs:** the BBC keyboard, and BREAK from the host only. Each person's keys are mapped to the matrix with
  their own layout, and a guest's go to the host to be sequenced. When a guest leaves, the keys it held are let
  go. Every machine's ADC reads its centre for the session's duration.
- **Transport:** WebRTC data channels in a star: each guest connects to the host only, over a reliable, ordered
  channel. A joiner's snapshot goes gzipped and in chunks over the same channel, discs included, so local and
  `gd:` discs need no fetching; each of the guest's drives takes a fresh copy of the host's disc, or is emptied,
  so nothing the session writes reaches the guest's own discs. Public STUN and no TURN: a guest that cannot
  connect is told "couldn't connect directly". The host and each guest see each other's public IP address. A
  guest on another model reloads as the host's before it joins, and one on another jsbeeb version is turned
  away. When the host leaves, each guest's machine carries on as a local one, with its own CMOS and clock back.
  The host takes only keys, resync requests and goodbyes from a guest, rate-limits its resyncs, drops one whose
  channel cannot keep up, and opens only a few connections at a time.
- **The clock:** every machine in a session reads its RTC as a base time the host sends plus its own emulated
  cycles, read as UTC, so everyone sees the host's wall time whatever their own time zone. It starts again from
  the wall time when the host's machine jumps.
- **Rendezvous:** one small AWS Lambda with a function URL, added to the existing bbc.xania.org CloudFront
  distribution as a second origin at `/api/rendezvous/*` with caching disabled, so it is same-origin with the
  page and needs no CORS. A DynamoDB table with a TTL holds each room's offers and answers. Creating a room
  returns a host secret, which the host sends to the rendezvous with each request that needs it and never to a
  guest. A guest creates an offer, waits for ICE gathering to finish (or a short timeout) so the full SDP goes
  in one message, posts it under an ID of its own, and polls for its answer. The host polls the room every
  second or two, answers each new offer, and keeps polling for the life of the session, for late joiners.
  Listing offers, answering and extending the room need the host secret; a guest can only post its offer and
  read its answer, so no guest sees another's address. Offers expire on their own short clock, so a guest that
  closes its tab while waiting cannot fill the room's cap of pending offers. The function checks IDs, caps
  bodies, treats anything past its expiry as gone (DynamoDB deletes lazily), and stores only the SDPs and the
  secret's hash. The dev and preview servers serve the same handler from memory, so sessions work locally with
  no AWS. Open tabs outlive a deploy, so the API stays backward compatible.
- **Infrastructure:** in [godbolt-terraform](https://github.com/mattgodbolt/godbolt-terraform): the function
  (Node 22, arm64, at most five at once), its table, role and log group in `new/jsbeeb-rendezvous.tf`, and
  `/api/rendezvous/*` on the bbc.xania.org distribution through `api_origins` on `module "jsbeeb"`. Terraform
  owns the function's shape and ignores its code; `deploy-jsbeeb` may update the code, and the deploy job does
  so before the S3 sync, as it already uploads assets before the HTML that names them.
- **Voice:** not in v0; use a separate call (Zoom, Discord, whatever people already have).

### Known gaps

- A lost packet holds back every message after it, so a guest's keys can reach the host in a bunch. The host
  applies a guest's keys at least 40ms apart, so a press and release that arrive together still make a tap the
  OS sees, though one held longer comes out 40ms long. A release that is itself held up still arrives late and
  lengthens the hold, enough to start the OS's auto-repeat; nothing but an input delay would hide that.
- Anything that changes a machine without going through the session (pasting, the reset menu, rewind, loading
  a state, the debugger, changing a disc) is not blocked. On the host, one that moves the cycle count resyncs
  every guest at once; anything else shows as soon as it reaches RAM, registers or the keyboard, and the
  guests are resynced from the host. A disc change or a poke at a device may not show until the program reads
  it. On a guest it is undone the same way.
- Anything that pauses the host pauses the session: a dialog, the rewind panel, saving or loading a state, the
  pause button. Guests wait, and catch up afterwards.
- Inputs the machine reads for itself rather than being sent (the gamepad fire buttons the system VIA reads,
  the accessibility switches on the user port) are not blocked either, and desync a session the same way if
  used.
- A guest's BREAK is ignored, and when a guest leaves, its keys are let go even if someone else is holding the
  same key.
- A guest's front panel and media window still name its own discs, though its drives hold the host's.
- A host's own `*CONFIGURE` changes made during a session are not saved, since its CMOS is the session's.
- A hidden host runs the session slowly (about a tenth of real speed, by the reasoning in challenge 6; not
  measured), and with its ticks that far apart a guest's press and release nearly always reach it together, so
  guests cannot type.
- A host that reloads keeps `?server=` in its URL; the room is deleted as the page goes, but if that is lost
  the reload is refused until the room expires, and a new name is the way out.

### What is left for v0

- An input delay, so a guest's keys apply as promptly as the host's and a late release does not lengthen a hold.
- More of the determinism test the experiment above stands for. The integration test already runs a B and a
  Master in random, uneven slices and compares cycles, RAM with the ROMs and sideways RAM byte for byte, the
  CMOS, the keyboard and the MODE 7 screen; still to come are a disc read during the run, framebuffers and
  device state.
- A build ID in place of the package version.
- Blocking in a session what bypasses it, and refusing configurations outside the scope.
- A share UI that generates the room's name.

After v0, in no fixed order: record and replay (a snapshot plus input log, which is spectating from a file);
snapshot links; the pulled inputs (ADC sources, gamepads, the mouse, the switches) through the session, with
`src/adc.js`, the sources and `getJoysticks` reading only what came through it; the other configuration options
one at a time; TURN; voice (below); and rollback (tier 4), only if tier 3 feels too laggy, which also needs
painting suppressed during re-emulation and the sound chip's queued events unwound.

### Voice, later

WebRTC carries audio as readily as data, so voice in the session is mostly UI:

- `getUserMedia` with the browser's echo cancellation and noise suppression, and the track added to the
  peer connection the session already has. Adding a track needs a renegotiation, but the offer and answer can
  go over the data channel, so the rendezvous is not involved; the host's whitelist of guest messages grows to
  take them. The audio is Opus, and the browser handles jitter.
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
