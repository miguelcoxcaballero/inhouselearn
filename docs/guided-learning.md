# Guided Learning: understand, apply, remember

This design rewards useful practice and visible progress. Time spent in the app is not a
learning outcome. The route, current mission, daily target and XP are reminders of work
completed; the memory labels reflect checks, not a certification of mastery.

## Learning loop and evidence

- **Retrieve and space.** Short tests require an answer before feedback. Local reviews
  revisit earlier questions and prioritize errors. Practice testing and distributed
  practice received high-utility ratings in [Dunlosky et al. (2013)](https://doi.org/10.1177/1529100612453266).
- **Work an example, then remove help.** Tutor instructions move from a prediction or
  worked example to a missing step and an independent problem. Optional hints cue a
  strategy. This follows the example-fading rationale in
  [Renkl & Atkinson (2003)](https://doi.org/10.1207/S15326985EP3801_3).
- **Choose the method.** The review alternates concepts, and the tutor is asked for
  application and transfer questions. Interleaving has experimental support in mathematics,
  including [Rohrer et al. (2020)](https://doi.org/10.1037/edu0000367). That study involved
  school mathematics, not aerospace undergraduates; applying it here is a design inference.
- **Do something with the idea.** A relevant visual supports predicting, explaining or
  calculating, rather than passive reading. The wider STEM evidence supports active learning:
  [Freeman et al. (2014)](https://doi.org/10.1073/pnas.1319030111) reviewed 225 undergraduate studies.
  This does not establish the effectiveness of this particular app.

For engineering, the tutor instructions emphasize physical meaning, labelled diagrams,
units, assumptions, estimates and limiting cases. For other subjects it adapts the task:
conceptual distinctions, causal explanations, sequences or textual evidence. The selected
level controls scaffolding. No diagnosis or personal learning-style claim is inferred.

## What the app enforces

`learning.js` is independent of the DOM and model. `guided.js` retains the course state
machine; `engine/src/guided.js` exposes the compatible extended quiz schema.

- Numeric answers use a finite decimal/scientific-notation parser, never `eval`. Decimal
  commas are supported. The requested unit is displayed separately; unit suffixes and
  expressions are rejected with an actionable message, rather than silently stripped.
  The tutor must supply a finite expected value and nonnegative **absolute** tolerance.
  Grading is deterministic against that key. The app does not independently verify that
  the model's physical setup or answer key is correct; prompts require a recomputation.
- New practice quizzes show the current question and the feedback for previous answers.
  Answers lock on checking; exams allow edits until submission and withhold feedback/hints.
  Existing quizzes retain their layout and answers. Draft numeric inputs survive reload.
- Practice gives 10 XP for an independent correct answer, 4 with a hint and 2 for an error
  followed by feedback. A concept contributes at most 40 XP and 4 exercises to a daily goal.
  Submission is idempotent. Each 100 XP advances a practice level; it is not a mastery score.
- Goals are 3, 6 or 10 corrected exercises **in this course**, adjustable in setup and the
  route. No daily-streak loss, lives, timers or random rewards. Meeting the goal offers a
  natural stopping point. Overall XP is kept; daily bookkeeping keeps the latest 90 days.
- Initial successful practice schedules recall after one day. Successful, unassisted
  **due** recall advances through 1/3/7/14/30-day intervals. Hints return to a one-day check;
  a failed check returns after ten minutes. Early successful practice never postpones a
  due date. These intervals and the 70% threshold are transparent product heuristics, not
  a calibrated individual memory prediction or a claim that these exact intervals are optimal.
- A review draws up to five questions across up to three concepts, alternating them and
  preferring past mistakes. It runs locally, without a model request, and leaves the current
  lesson and course status untouched. It reuses prior questions, so it checks retention;
  fresh transfer questions still come from the tutor's quizzes/exam. There is no background
  notification or scheduler; due status is computed when the course is rendered or resumed.
- Evidence labels distinguish initial understanding, recall and repeated spaced recall.
  Skipped lessons are explicitly untested. Old courses migrate with no invented XP or
  inferred memory evidence. Surviving lessons retain stable identity across reordering.

## Validation and limits

### Visual screens and learner-controlled readiness

The focused workspace uses the actual message elements, not duplicated transcripts or
simulations. Previous/next screens are local and do not request a model response. Only the
explicit readiness button at the end does: understand → apply → check. Arrow keys/swipes
cannot trigger that transition. The transcript toggle restores the full conversation.
The composer and header retain their own grid rows; content can scroll without covering them.
Long prose is optional behind “Ver explicación”; teaching prompts request 35–50 words around
one visual and at most 30 words per walkthrough step. No material is deleted.

`lesson.phase` replaces message counts as the phase indicator and quiz gate. Explicit confusion
from composer text or a quick action returns to understanding, requests a simpler different
representation and supersedes an unsubmitted lesson quiz. Failed checks also return to
understanding. The tutor cannot create another quiz until the learner explicitly requests one.
This is readiness as reported by the learner, not a claim that pressing a button proves mastery.

`explain` reuses one `SceneView` with cumulative control presets, highlighted object identities,
before/after comparison and an optional takeaway. Changing a control enters free exploration:
preset conclusions are hidden until the learner restores a preset. Shape assets are silhouettes,
not validated aerodynamic geometry. State transitions are illustrative, not integrations of time.
Existing scenes remain valid; explain scenes keep labels at least a 14px font at phone
widths. Walkthrough state survives DOM redraws in this tab; like existing visuals it resets on reload.

`check_diagram` renders isolated, noninteractive previews at 360px and 960px and measures labels
in the real browser. It reports text collisions, bounds, small text and invalid expressions in
each authored state and at individual slider minimum/midpoint/maximum and toggle values.
It accepts declarative scenes/walkthroughs or sanitized inline SVG; it runs no author JavaScript and removes external SVG image/reference elements before mounting. Previews
are removed and their animation/resize observers released. The tutor is instructed to check,
revise and recheck (2–3 passes, at most three tool calls per turn). This does not verify physical
truth, every possible slider combination, arrow/body intersections or model compliance. Diagram
quality still depends on the model's reasoning and sources; no automatic check guarantees correctness.

`guided-screens.cjs` covers the actual tool loop, a deliberately overlapping diagram and its
correction, before/after and free exploration, lesson-title LaTeX, repeated confusion, readiness,
screen navigation, transcript access, text disclosure, responsive layout and reduced motion.

`node --test tests/web/learning.mjs` tests scoring, migration, intervals, repeated submissions,
day rollover, hint handling and mixed review selection. `tests/web/guided-learning.cjs`
exercises actual browser interactions and mocked model tool calls, reload, review, exam,
replanning, mobile/desktop layout, dark mode and reduced motion. Existing text-quality and
motion tests remain in place. These are software checks, not a learning-outcome experiment.

The teaching sequence is instructed to the model; its pedagogical quality and factual
correctness vary by model and source materials. Numeric grading checks a result, not the
student's derivation. Explanations and assumptions should still be discussed with the tutor.
A real effectiveness evaluation would compare delayed retention and novel problem solving,
not session duration or XP totals.
