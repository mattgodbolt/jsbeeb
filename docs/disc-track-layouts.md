# 40 and 80 track discs

How jsbeeb works out where a disc image's tracks belong on the surface, why it guesses the way it
does, and what the guesses were checked against. The mechanics live in `src/disc.js`,
`src/disc-drive.js` and `src/fdc.js`; this is the reasoning behind them.

## The physical thing being modelled

A 40 track drive writes at 48 tracks per inch, an 80 track drive at 96. Both use the same media, so
a 40 track disc's tracks sit on every other track of an 80 track drive's grid: logical track N at
physical track 2N. An 80 track drive reads such a disc by **double stepping**, moving its head two
positions for each track the controller asks for. Real drives had a switch for this, sometimes one
per drive, and setting it wrong is how a disc read as noise.

The track pitch matters more than it first appears. At 48 tpi the pitch is 0.53mm and a written
track is about 0.33mm wide, so the neighbouring 96 tpi position, 0.265mm away, falls outside
anything the write puts down: it is guard band. A 40 track write therefore leaves **nothing
readable** on the track next to it, rather than a fainter copy of itself. That is why `Disc` models
a fat write as erasing its neighbour, and why an 80 track drive single stepping across a 40 track
disc finds empty space rather than data.

`Disc` holds the physical surface: 84 slots at 96 tpi spacing. The drive owns the stepping, as
`tracksPerStep`, which is 1 or 2. Nothing else in the emulator knows about any of this: the 8271 and
the 1770 ask for a track and the drive decides how far to move.

## The three kinds of evidence

An image is either a list of sectors or a picture of the surface, and they are asked different
questions. All of it happens once, in `discFor`, which every load path goes through, and the answer
and its reason are logged.

**A sector image (SSD, DSD) is asked its catalogue.** The DFS catalogue records how many sectors the
disc has: 400 for 40 tracks, 800 for 80. An image whose catalogue is structurally sane, claims from
1 to 400 sectors, and holds no data past where 40 tracks reach is laid out double spaced by
`loadSsd`, logical track N built at physical 2N, with the tracks between left unformatted so they
read as the weak bits an unwritten surface gives.

**The file's size is not evidence.** Images are routinely padded out to a full 200K or cut short
after the last used sector, in both directions, so size says nothing about pitch. Two real examples,
both from the STH archive: `Plus3GamesDisc-ADFS_E.adf` is exactly the 160K of a 40 track ADFS disc
while its map claims 1280 sectors, and `MelbourneHouse/TheHobbit-GameDisk.ssd` is exactly 100K with
a catalogue that agrees. Size would have called the first 40 track and it is not.

**A flux image (HFE) is asked its header, then its surface.** A capture that declares no more tracks
than half a surface cannot be of an 80 track disc, so it is expanded on load. Otherwise the surface
itself is read: a track written by a 48 tpi head sits at twice the number its own sector headers
claim, with nothing readable on the tracks between. That question needs no filesystem behind it, so
it serves ADFS as well as DFS, and it is the only way to spot the common case of a 40 track disc
captured by stepping every position of an 80 track drive, which declares 80 odd tracks honestly.

## Decisions worth knowing about

**DFS keeps its catalogue entries in descending order of start sector, and we do not check that.**
The rule is real, but images in the wild were not all written by DFS, and a wrong "yes" here cannot
hurt: software reads the same logical tracks whichever pitch the image is laid out at, and the one
case where expanding would lose data has its own rule. Over the STH archive the check cost one
genuine 40 track disc, The Hobbit, and gained nothing.

**Only the lower side of a flux image is asked.** Both heads move together, so a disc has one pitch
at any instant, but a disc can be written in two passes and some were: a **dual format** disc carries
side 0 for a 40 track drive and side 1 for an 80 track one, the same game twice. Ten discs in
scarybeasts' archive are catalogued that way, five of them Elite, and `public/discs/elite.hfe` is
one. Since a drive's switch is not per side, side 0, the one DFS boots from, decides; reaching the
other side means setting the switch by hand, exactly as it would on real hardware.

**A wrong guess cannot lose data.** For a sector image, expanding only changes where the loader puts
tracks it was going to write anyway, and an image with content past track 42 is refused. For a flux
image nothing is moved at all: only the drive's switch changes. This is why the sector-image rules
can afford to be relaxed and the surface rule cannot, since double stepping a genuine 80 track disc
would land the head between its tracks. The surface rule therefore refuses on the first odd track
holding sectors of its own, and wants four tracks agreeing before it believes.

## What the guesses were checked against

`tools/sniff-disc-layout.js` walks a directory of images and reports the verdict and reason for
each, so any change to this can be tried against a corpus first.

Over a full mirror of the **Stairway to Hell** disc archive, 1607 sector images: 10 read as 40 track
and 1597 as 80, which is the shape you would expect of a BBC archive.

Over a full mirror of **scarybeasts' HFE archive**, 656 flux images, checked against the `tracks`
column its catalogue records with `--manifest`: **654 agree**, including every one of the 429 discs
catalogued as 40 track. The two that disagree are both catalogued `80 (dual)` and both are, on the
surface, unarguably double stepped, with every even track holding sectors numbered half its
position and nothing on the odd ones. One of them is The Hobbit, whose own DFS catalogue also says
400 sectors; the other is Quest, whose catalogue claims 800 while its data sits on every other
track, which may itself be protection, since a copier that believes the catalogue will look for 40
tracks that are not there.

That archive is mostly protected discs, which is why it exists: 40% of it has deleted-data sectors,
24% has a formatted track past 79, and 18% has a sector numbered past 9. Layout detection has to
survive all of that, which is the main reason it asks narrow questions.

## The switch

`drive0Tracks` and `drive1Tracks` fix a drive's switch from the URL, and the Discs menu shows and
sets it. A drive left alone follows whatever disc is loaded into it, which no real drive does: it is
jsbeeb doing the user a favour, and `fdc.loadDisc` is where the favour is done. `80` turns the whole
business off for that drive, loading every image the way jsbeeb did before it could tell them apart.
