# 40 and 80 track discs

How jsbeeb works out where a disc image's tracks belong on the surface, why it guesses the way it
does, and what the guesses were checked against. The mechanics live in `src/disc.js`,
`src/disc-drive.js` and `src/fdc.js`; this is the reasoning behind them.

## The physical thing being modelled

A 40 track drive writes at 48 tracks per inch, an 80 track drive at 96. Both use the same media, so
a 40 track disc's tracks sit on every other track of an 80 track drive's grid: logical track N at
physical track 2N. An 80 track drive reads such a disc by **double stepping**, moving its head two
positions for each track the controller asks for. 80 track drives were switchable between the two,
and setting the switch wrong is how a disc read as noise.

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

An image is either a list of sectors (SSD, DSD, ADF, ADM, ADL) or a picture of the surface (HFE),
and the two are asked different questions. All of it happens once, in `discFor`, which every load
path goes through, and the answer and its reason are logged.

**A DFS sector image (SSD, DSD) is asked its catalogue.** The DFS catalogue records how many sectors the
disc has: 400 for 40 tracks, 800 for 80. An image whose catalogue is structurally sane, claims from
1 to 400 sectors, and holds no data past where 40 tracks reach is laid out double spaced by
`loadSsd`, logical track N built at physical 2N, with the tracks between left unformatted so they
read as the weak bits an unwritten surface gives.

**The file's size is not evidence.** Images are routinely padded out to a full 200K, or cut short
after the last sector holding anything, so size says nothing about pitch. Two real examples, both
from the STH archive: `Plus3GamesDisc-ADFS_E.adf` is 160K, the size of a 40 track ADFS disc, but its
map claims the 1280 sectors of an 80 track one, and it is the map that is right;
`MelbourneHouse/TheHobbit-GameDisk.ssd` is 100K and really is 40 tracks. Going by size would have
called both of them 40 track and been wrong about the first.

**An ADFS sector image (ADF, ADM, ADL) is not asked anything**, and is always laid out
contiguously. ADFS comes in three sizes: S is 40 tracks on one side, M is 80 on one, L is 80 on
both, and only S is double spaced. The free space map would say which, holding the disc's total
sectors at offset 0xFC of sector 0 as three bytes, little endian, where 640 means S. Nothing reads
it, because no S turned up to test a rule against: of the 23 ADFS images in the Stairway to Hell
archive, 22 are M and one is L. An ADFS disc held in a flux image is covered anyway, since the
surface is read without reference to any filesystem.

**A flux image (HFE) is asked its header, then its surface.** A capture that declares no more tracks
than half a surface cannot be of an 80 track disc, so it is expanded on load. Otherwise the surface
itself is read: a track written by a 48 tpi head sits at twice the number its own sector headers
claim, with nothing readable on the tracks between. That question needs no filesystem behind it, so
it serves ADFS as well as DFS. It is also the only way to spot a 40 track disc captured by stepping
every position of an 80 track drive, which is the usual way to take one and leaves a header
truthfully declaring eighty or more tracks.

## Decisions worth knowing about

**Only the lower side of a flux image is asked.** Both heads are on the same cylinder at any
instant, but a disc can be written in more than one pass, and some were: a **dual format** disc
carries side 0 for a 40 track drive and side 1 for an 80 track one, the same game twice. Ten discs
in scarybeasts' archive are catalogued that way, five of them Elite, and `public/discs/elite.hfe` is
one of them. A drive's switch is not per side, so the side DFS boots from decides. Reaching the
other side means setting the switch by hand, which is what it would take on real hardware too.

**A wrong guess about a sector image cannot lose anything; a wrong guess about a flux image can
stop the disc reading.** Expanding a sector image only changes where the loader puts tracks it was
going to write anyway, and one with content past track 42 is refused, so the worst a mistake costs
is where the tracks sit on a surface nobody was looking at. A flux image is not moved at all, and
only the drive's switch changes, but double stepping a disc that was never written that way lands
the head between its tracks and it reads nothing. That is why the sector rules can afford to be
relaxed and the surface rule cannot: it refuses on the first odd track holding sectors of its own,
and wants four tracks agreeing before it believes.

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

Much of that archive is protected discs, which is why it exists: 40% of it has deleted-data sectors,
24% has a formatted track past 79, and 18% has a sector numbered past 9. Layout detection has to
survive all of that, which is the main reason it asks narrow questions.

## The switch

`drive0Tracks` and `drive1Tracks` fix a drive's switch from the URL, and the Discs menu shows and
sets it. A drive left alone follows whatever disc is loaded into it, which no real drive does: it is
jsbeeb doing the user a favour, and `fdc.loadDisc` is where the favour is done. `80` turns the whole
business off for that drive, loading every image the way jsbeeb did before it could tell them apart.
