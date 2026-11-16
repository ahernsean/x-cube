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

A **turn** is something a person does to the puzzle: turning one layer. The turn list,
Undo ("Undo the last turn"), the turn buttons and a step's "Turns:" all count turns.
Nothing else is a turn: not a cubelet changing which way it faces, and not the view
moving.

A cubelet's **orientation** is which way it faces in its spot, and to **orient** one is to
change that. So a problem with the core corners says "The core corners can't all have
these orientations at once. One of them needs a different orientation", not that one
"needs another turn".

The view **rotates** ("Show rotates the view to them"), and a drag **tumbles** it; two
fingers **spin** it.

A **step** is one step of a solve, as the Solve panel gives it. An **algorithm** is a
known or saved sequence of turns, as in the Algorithms panel.

## Ideas with no user-facing word

Some ideas are how the Lab works something out, not something a user can see or act on,
so they don't appear at all. The outward-color rule is one: a message never says which
color points "outward" or "straight out from the core". It says what is wrong in terms
the user can check against the puzzle in hand: "These two X-face corners look the same,
but the puzzle has only one like that. One of them has a sticker with the wrong color."

## How to say it

Say what is, and what happens now, not what doesn't happen: "Drag anywhere to tumble the
view", not "Layers don't turn while editing".

Say what the user can do about it. A problem message names the problem and, where it
can, what to fix ("One of them has a sticker with the wrong color"), not how the Lab
found it.

Point rather than place. A problem names what is wrong, not where; the purple halo shows
where. Words for a spot have proved unreliable: center colors move with slices,
extensions leave their sides, and left and right depend on how the puzzle is held.

A cubelet in its place and oriented as solved is **solved**, not "home": Home is a view.

In help text, a button's name is drawn as a control (`<span class="ui-name">Show</span>`),
so it reads as the button and not as a verb.

Lists of three colors use the serial comma: "white, blue, and orange".
