# Wording in the X-Cube Lab

How the Lab talks to the person using it: messages, help, labels, tooltips and the
words read aloud (`aria-label`). Use these words in anything a user can see or hear.
Code, comments and `AGENTS.md` keep their own terms (`paint`, `outward`, `slot`): this
file is only about what the user sees.

## Words to use

| Use | Never | Meaning |
|---|---|---|
| **color** (a sticker's color; "give it the picked color", "has no color yet", "has the wrong color") | paint, painted, repaint | What a sticker shows. The editor's internal "painting" is not a word for users: twisty puzzles have stickers, not paint. |
| **puzzle** | cube | The X-Cube as a whole, on screen or in hand. |
| **sticker** | | One colored face of a cubelet. |
| **cubelet** | piece, cubie | One of the small cubes the puzzle is made of. |
| **left, right, up, down, front, back** | | The six sides, as the puzzle is held now (see below). |
| **turn** | | Turning a layer, a slice or the whole puzzle ("turn a layer", "Turn the puzzle over"). |
| **step** | | One step of a solve, as the Solve panel gives it. |
| **algorithm** | | A saved or known sequence of turns, as in the Algorithms panel. |

Internal ideas that have no user-facing word, and so don't appear at all:

- **outward**, "pointing straight out from the core": the outward-color rule is how the
  Lab checks the colors, not something a user can act on. Say what is wrong in words the
  user can check against the puzzle in hand ("These two X-face corners look the same,
  but the puzzle has only one like that").

## How to say it

- **Say what is, and what happens now**, not what doesn't happen. "Drag anywhere to tumble
  the view", not "Layers don't turn while editing".
- **Say what the user can do with it.** A problem message names the problem and, where it
  can, what to fix ("One of them has a sticker with the wrong color"), not how the Lab
  found it out.
- **Point, don't place.** A problem names what is wrong, not where: the purple halo shows
  where. Words for a spot proved unreliable (center colors move with slices, extensions
  leave their sides, left and right depend on how the puzzle is held).
- **Sides are as the puzzle is held now.** The Hold line says which center is up, in front
  and on the right; a stage is named by color ("Yellow core edges"), not place, since the
  puzzle may be held either way up.
- **Solved, not home**, for a cubelet in place and turned right: Home is a view.
- **Name controls as controls.** In help text a button's name is drawn as a UI element
  (`<span class="ui-name">Show</span>`), so it reads as the button and not as a verb.
- Lists of three colors use the serial comma ("white, blue, and orange").
