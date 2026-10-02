# Shared and multiplayer sessions

What it would take for several people to share one jsbeeb machine: send someone a link to my machine as it is
now, let people watch me play, or have two or more of us at the keyboard of the same emulated Beeb from
different browsers. Nothing here is implemented; this is a design to pick holes in.

## What we mean

Four tiers, each building on the one before and each worth having on its own.

1. **Share a snapshot.** A link that opens jsbeeb on my machine exactly as it was when I made the link. One
   upload, no live connection. Needs a snapshot that is complete enough to stand alone, and somewhere to keep it.
2. **Spectate.** I host; anyone with the link watches the same machine running live in their own browser. No
   video is streamed: every viewer runs their own emulator from my snapshot and replays my inputs. Needs
   determinism, an input stream, a relay and late joining. Viewers can lag a fraction of a second behind and
   nobody minds.
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
50Hz Beeb; the 1MHz, 60Hz Atom wants its own), and fine enough for the keyboard, which the BBC OS scans from
its 100Hz interrupt. The quantum is a fixed cycle count, not tied to the video's vsync, so it does not care
what the CRTC is programmed to do. A press and release that land in one quantum are spread over two, or the
machine would never see the key.

**One sequencer orders the inputs.** Someone has to say "frame N has exactly these inputs, and no more are
coming". The proposal is a single sequencer per session: peers send their inputs as they happen, and the
sequencer stamps each with the frame it applies on (the sender's current frame plus an input delay, or the
next frame not yet committed, whichever is later) and broadcasts `commit(N, inputs)` at a fixed rate, empty
or not. Every peer runs up to the last committed frame and no further. Peers never need to hear from each
other directly, and a quiet peer costs nothing because nobody waits on it. Whether the sequencer is the
host's browser or the server is an open question below; the protocol is the same either way.

**Inputs are machine-level events.** A key is sent after the sender's own mapping (layouts, user remaps in
`src/keymap.js`), not as a host key code, because mapping is per-person configuration. That is more than a
matrix position: in the symbolic layout a key can force BBC SHIFT up or down while it is held (`SysVia.set`,
`src/via.js:700`), so an event carries the position and the SHIFT it forces. With two people on one matrix,
whose SHIFT wins needs a rule; the simplest is that each person's held keys are tracked separately and a
forced SHIFT applies only while that person's key is down, but that is an open question. An analogue channel
is sent as a value change. BREAK, reset, disc changes and pastes are events too.

**Pacing.** Locally the emulation loop works out how many cycles to run from `performance.now()`, capped at a
tenth of a second, and nudges itself to keep the audio buffer full (`src/web/emulation-loop.js:220`, `:277`).
In a session the same loop gets one more cap: never past the last committed frame. `setEmulationLead` runs the
CPU itself to build audio lead (`:282`), so it needs the same cap. A peer that gets ahead
simply waits, which with a few frames of committed buffer should be inaudible. One that falls behind (a
commit arrived late, a slow phone) has to catch up by running faster for a while; today a stall longer than
the cap is dropped instead (`emulatedTo` jumps to now), which a session cannot allow. Catching up must not
use the speedy frame skip: `FRAMESKIPENABLE` also gates video memory reads and the SAA5050's clocking
(`src/video.js:1099`), so a peer that skipped frames ends up with different teletext state in MODE 7.

**Late joining.** The host takes a snapshot at a committed frame boundary and sends it along with the
session's machine description; the joiner restores it, then runs flat out through the commits since. On my
desktop, Node emulates a 50Hz frame of a B running Elite in about 3ms, so catching up is quick. The host
does not pause.

**Desync detection and recovery.** Every so often (each second, say) every peer hashes its machine state at a
committed frame and sends the hash to the sequencer. The host's hash is the reference, as in RetroArch: a
peer that differs is sent a fresh snapshot from the host and rejoins as a late joiner would. If the host is
the one that went wrong (a debugger poke, say), it is still right by definition, which is one reason the
debugger is a host-only tool in a session. The hash covers the file form of the state (dirty disc tracks
only, not the megabytes of clean ones), and leaves out the frame-skip bit in `video.dispEnabled`, which
differs between peers for reasons of display alone.

**Is it deterministic today?** Mostly. A quick experiment, using the headless `MachineSession` with the real
video and sound chip: boot Elite on a B and on a Master, snapshot, restore into fresh machines, run with the
same key pressed and released at the same cycles, but in execute chunks of 100,000, 37,813 and 1,997 cycles.
The machine state and framebuffer came out identical in every case. So chunking does not leak, and the CPU,
VIAs, video and FDC are already a deterministic function of state plus inputs, at least on that path (it
never ran speedy, and never touched the Atom). The work is in the edges.

## The major challenges

Ranked by how much they would bite.

1. **Inputs arrive on host time.** The keyboard writes straight into the system VIA when the browser event
   fires (`src/web/keyboard.js:227`), as does BREAK (`:209`) and the Mac caps lock "tap", released by a
   `setTimeout` (`:259`). Gamepad keys are polled at the start of each tick (`src/web/emulation-loop.js:224`
   into `src/web/gamepads.js:241`). All of it lands at whatever cycle the current tick happens to have
   reached. Everything has to go through one queue that applies events at frame boundaries; that is the
   central refactor and is useful without any networking.
2. **Some inputs are pulled, not pushed.** The ADC asks its source for a value when a conversion finishes
   (`src/adc.js:164`), so the gamepad, mouse-as-joystick and microphone sources are read mid-emulation. The
   system VIA reads gamepad fire buttons live (`getJoysticks`, `src/via.js:877`). These must change so the machine only ever
   sees values that came through the input queue.
3. **Snapshots are not complete enough for a joiner.** The native snapshot leaves out:
   - the keyboard matrix and the SHIFT override state (`SysVia.snapshotState`, `src/via.js:645`), so a joiner
     arriving while a key is held sees it up;
   - sideways RAM, which lives in the ROM area and is only saved with `includeRoms` (`src/6502.js:1234`);
   - the Master's CMOS RAM, which comes from each person's `localStorage` (`src/cmos.js:43`, persisted by `localStoragePersistence`);
   - tape position (a known limitation in `docs/snapshot-format.md`), Music 5000 and Econet state, a paste in
     progress (the typist's queue), and the mouse buttons.

   It also leaves out the framebuffer, which is only cosmetic: a joiner sees black until the next frame. With
   media by reference and dirty tracks only, a B with Elite running comes to about 25KB gzipped; a full
   in-memory snapshot with every disc track is about 190KB gzipped. Adding sideways RAM (64KB raw on a
   Master) and CMOS will grow the first figure.

4. **Wall clock leaks into the Master.** The RTC reads `Date.now()` on every access (`src/cmos.js:19`) and
   setting it stores an offset from the host clock (`:183`). Two Masters read different seconds. The clock
   needs to be derived from emulated cycles plus a base time carried in the snapshot. The Econet file server's
   date call (`src/filestore.js:84`) is the same problem in a corner nobody will hit first.
5. **The machine must be configured identically.** `restoreSnapshot` checks only the model and co-processor
   (`src/snapshot.js:96`). CPU multiplier, `videoCyclesBatch`, Music 5000, teletext adaptor, Econet and extra
   ROMs (`?rom=`) all change behaviour and must be part of a session description that a joiner adopts, the way
   a cross-model snapshot load already reloads the page as the right machine (`src/web/snapshot-ui.js:132`).
   Media must be fetchable by everyone: `sth:` and URLs are, embedded local files are, a `gd:` Google Drive
   reference is not without the viewer's own authorisation.
6. **Local controls that change state.** Rewind, loading a state, the debugger, fast-as-possible and fast
   tape, hidden-tab pause (`src/web/emulation-loop.js:289`), media changes and reset all act on one peer's
   machine. In a session each either becomes a session event (reset, disc change, perhaps rewind for everyone)
   or is turned off for guests. A hidden guest tab must not stall everybody, and with a sequencer that only
   waits on time it does not. A hidden host tab is different if the host is the sequencer: today the loop
   pauses itself when hidden, and browsers throttle timers in background tabs, so commits would stall or
   bunch for everyone and no snapshot could be taken for a joiner. In a session the host keeps running when
   hidden, and how well it can under background throttling is a cost of host-as-sequencer.
7. **Two clocks.** Each browser's audio runs on its own crystal, and in a session the emulation rate is set by
   the sequencer. Over minutes they drift, so each peer either stretches its audio slightly or skips and pads
   it. The existing emulation lead logic (`setEmulationLead`) is the place for that.
8. **Smaller ones.** The Atom randomises some RAM on reset (`src/6502.js:1706`), so reset needs a session-wide
   seed. The disc noise picks its clicks with `Math.random` (`src/ddnoise.js:84`), but that is audio only and
   harmless.

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

The site is static, synced to S3 on every merge to main (`.github/workflows/test-and-deploy.yml`). A session
needs a relay (and somewhere to keep snapshot links); the emulator never runs on the server.

Traffic is small. Inputs are a few bytes each. Commits at 25 a second (every other frame) to four peers are
100 messages a second out, plus a hash per peer per second. Snapshots are tens of KB and go once per join.

| Option                                       | Good                                                                                                                                                | Bad                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Gateway WebSocket + Lambda + DynamoDB    | Same AWS account as the site and Compiler Explorer; nothing to run; costs nothing when idle                                                         | Every message is a Lambda invocation and fan-out is a loop of `PostToConnection` calls; no clock of its own, so it cannot be the sequencer; 128KB message cap; connections cut at two hours and after ten idle minutes; about $1 a million messages |
| Cloudflare Durable Objects with WebSockets   | One object per room holds the connections in memory, can run a timer, so can be the sequencer; fan-out is a loop over sockets; idle rooms hibernate | Another provider and account; new deployment tooling                                                                                                                                                                                                |
| Small always-on box running a `ws` relay     | Simplest code (the relay the tests would use too); can be the sequencer; flat cost                                                                  | A server to keep patched and up; one region                                                                                                                                                                                                         |
| WebRTC data channels, signalling server only | Lowest latency, peer to peer; server traffic tiny                                                                                                   | NAT traversal needs STUN, and TURN for the unlucky; a mesh for N peers or the host as hub; much more client code                                                                                                                                    |

Prices and limits are as each provider lists them at the time of writing; check before relying on them.

The recommendation is to keep the relay dumb and the protocol transport-agnostic: the host's browser is the
sequencer to start with, and the relay only forwards messages within a room. That works on any of the four,
at the cost of the hidden-host-tab problem in challenge 6. Develop against a small Node relay checked into the
repo (`ws` would be a new dependency), which the integration tests can also run. Which
of the hosted options it goes on is an open question; API Gateway fits the existing setup, and if its latency
shows, the same protocol moves to an always-on process or a Durable Object, which could then take over as the
sequencer.

## First steps

Each of these is a PR that is useful on its own, in order.

1. **A determinism test.** An integration test that boots a B and a Master with a disc, and an Atom, snapshots,
   then runs several fresh machines from that snapshot with the same recorded input log (including a hard
   reset) in different chunk sizes, and compares state hashes and framebuffers, as the experiment above did.
   Adds a `stateHash` helper. Touches tests and one small module. Catches nondeterminism on the paths it
   exercises; the Atom's reset will fail it until it is seeded.
2. **One input queue.** Route keyboard, BREAK, gamepad keys, gamepad and mouse analogue values and fire
   buttons through a cycle-stamped queue applied at quantum boundaries; the ADC and system VIA read only what
   came through it. Touches `src/web/keyboard.js`, `src/web/gamepads.js`, `src/adc.js`, the analogue sources,
   `src/via.js`, `src/ppia.js` (the Atom's keyboard) and `src/web/emulation-loop.js`. Inputs gain up to one quantum of latency, and a tap shorter
   than a quantum is held for one; otherwise nothing visible changes.
3. **Record and replay.** Save a snapshot plus input log, and play it back exactly. Good for bug reports
   ("here is the crash, press play") and demos, and it is spectating with a file instead of a socket. The
   step 1 test grows to cover it.
4. **Close the snapshot gaps.** Keyboard matrix, sideways RAM, CMOS contents, an RTC driven by emulated cycles
   from a saved base time, and the configuration fields from challenge 5. Touches `src/via.js`, `src/6502.js`,
   `src/cmos.js`, `src/snapshot.js` and `docs/snapshot-format.md` (a version bump).
5. **Shareable snapshot links** (tier 1). Upload a file snapshot and get a link that opens it; needs a decision
   on where snapshots live.
6. **Relay and spectating** (tier 2). The Node relay, rooms with unguessable IDs, the host streaming commits,
   late joining and desync hashes. Guests cannot type yet.
7. **Shared keyboard** (tier 3). Guests' inputs go through the sequencer, with an input delay and a per-session
   rule for who may reset or change discs.
8. **Rollback** (tier 4), only if tier 3 feels too laggy in practice. It also needs painting suppressed during
   re-emulation and the sound chip's queued events unwound.

## Open questions

- Who sequences: the host's browser (simplest, but the host has no input delay, everyone else has a round
  trip, and a hidden host tab may stall the session), or the server (fair, but needs a stateful server)?
- How SHIFT is shared when two people hold keys that force it different ways.
- Where it is hosted: API Gateway, an always-on box, Durable Objects or WebRTC.
- Where shared snapshots live (S3 behind a small upload endpoint, a gist, the user's Google Drive), for how
  long, and whether that is acceptable given a snapshot holds whatever was in RAM.
- How much input delay is right by default, and whether a session should choose it from measured latency.
- What a guest may do: type only, or also reset, change discs, rewind for everyone.
- Whether the Electron app should be able to host.

---

This design was drafted by Claude (an LLM) with Matt.
