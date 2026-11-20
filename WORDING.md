# Wording in the X-Cube Lab

How the Lab talks to the person using it: messages, help, labels, tooltips and the
words read aloud (`aria-label`). Code, comments and `AGENTS.md` keep their own terms
(`paint`, `outward`, `slot`); this file is only about what a user sees or hears.

## The puzzle and its parts

The X-Cube is the **puzzle**, whether on screen or in hand, never "the cube".

It is made of **cubelets**, the small cubes that move. Each shows its **stickers**, the
colored squares on its faces. A sticker has a **color**. The editor's tools color
stickers ("Pick a color, then tap stickers to color them"); a sticker with no color yet
"has no color yet", and one colored wrong "has the wrong color". Twisty puzzles have
stickers, not paint, so the Lab never says "paint" to a user, though the code calls the
editor's coloring "painting".

The sides of the puzzle are **left, right, up, down, front** and **back**, as the
puzzle is held now. The Hold line says which center is up, in front and on the right.
Since the puzzle may be held either way up, a stage of a solve is named by color
("Yellow core edges"), not by place.

A **layer** is a slab of cubelets that turns together: one side's 3x3x3 layer with
everything beyond it (`R`), a middle slice (`M`, `H`, `S`), or an extension by itself
(`r`, an outer layer).

## Turns, orientation and the view

A **turn** is something a person does to the puzzle: turning one layer. Undo ("Undo the
last turn"), the turn buttons and a step's "Turns:" count turns. Nothing else is a turn:
not a cubelet changing which way it faces, not the whole puzzle moving in the hand, and
not the view moving.

The whole puzzle **rotates** (`x`, `y`, `z`): "Rotate the whole puzzle so the white
center is up". A half rotation (`x2`, `y2`, `z2`) may be called a **flip**: "Flip the
puzzle over, so yellow is up", "Flip the puzzle around, so blue is in front". A flip is
always 180 degrees; a quarter rotation is never a flip. A flip over and around at once
is one move, so it is said as one: "Reorient the puzzle in your hand so that white is up
and blue is in front". Don't say "spin" for the
puzzle: it suggests continuous motion.

A cubelet's **orientation** is which way it faces in its spot, and to **orient** one is to
change that. A cubelet may also be **rotated**: a problem with the core corners says "The
core corners can't all be oriented as they are now. One of them needs to be
rotated", not that one "needs another turn".

The view **rotates** too ("Show rotates the view to them", "Drag to rotate the view");
a drag **tumbles** it, and two fingers **spin** it.

A **step** is one step of a solve, as the Solve panel gives it. An **algorithm** is a
known or saved sequence of turns, as in the Algorithms panel.

## Ideas with no user-facing word

Some ideas are how the Lab works something out, not something a user can see or act on,
so they don't appear at all. The outward-color rule is one: a message never says which
color points "outward" or "straight out from the core". It says what is wrong in terms
the user can check against the puzzle in hand: "Two X-face corners look the same,
but the puzzle has only one like that. One of them has a sticker with the wrong color."

## How to say it

Say what is, and what happens now, not what doesn't happen: "Drag anywhere to tumble the
view", not "Layers don't turn while editing".

Say what the user can do about it. A problem message names the problem and, where it
can, what to fix, not how the Lab found it. Best is which sticker should be which color
("Its red sticker should probably be orange"); when the Lab can't tell, "One of them has a
sticker with the wrong color". A sticker is named by its color, never by its place; where its color doesn't say which
sticker (two of one color on a cubelet), the Lab circles it and calls it "circled": "Its
circled orange sticker should probably be green". A center is named by its color too ("The
red center"), since no two centers show one color.

A halo marks a cubelet, or the spot where one should go (the Shape tool's glass box
there); a ring marks a sticker. So a shape hint points with the halo and says "this" or "here".
Say what is certain plainly and what is a guess with "probably", in the same sentence
if need be: a core corner with one extension must get another, on that corner and nowhere
else, but which of its spots is a guess ("Add an extension to this corner, probably
here"). When the halo marks every spot that could be, nothing is guessed ("Add an
extension to this edge in one of these spots"). Which of several cubelets to change is a
guess too ("This extension should probably be removed"). In shape messages an extension cubelet is "an extension"; a center's is "an
extension center". Two stickers in each other's spots "trade places", not colors: a sticker
is the thing that is wrong, and the user moves it.

"This", "these" and "here" point: whatever they refer to is marked, with the halo (a
cubelet, or the spot for one) or a ring (a sticker), so the user can see what is meant.
"This core corner has three extensions, but it can have only two. This extension should
probably be removed" halos both the corner and the extension. A message that names spots
the halo doesn't mark says how many, without "these" ("Two X-face corners look the same,
but the puzzle has only one like that").

Point rather than place. A problem names what is wrong, not where; the purple halo shows
where. Words for a spot have proved unreliable: center colors move with slices,
extensions leave their sides, and left and right depend on how the puzzle is held.

A cubelet in its place and oriented as solved is **solved**, not "home": Home is a view.

In help text and messages, a button's name is drawn as a control (`<span class="ui-name">Show</span>`;
a message names its controls with `setMessage`'s `controls`), so it reads as the button and
not as a verb: "To add or remove an extension, pick **Shape** first".

Lists of three colors use the serial comma: "white, blue, and orange".

Every message the Lab shows ends as a sentence does, with a period ("Debug info put back.",
"Turns cleared. This position is now the start."); `setMessage` adds it. The problem line
adds its own after the problem ("Not valid: ... spots.").
