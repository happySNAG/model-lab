# Reference solutions

One directory per workspace case, holding the files a CORRECT answer to that case writes.

**They are here and not under `fixtures/workspace/` on purpose.** `fixtures/workspace/<name>` is the
tree a model is handed; anything in it is one `ls` away from being read. A solution sitting there
would make every case it belongs to measure nothing at all, and the sealed tree digest would carry
it. These files are never copied into a workspace: the scripted agent in
`test/engine/workspace-tier-discrimination.test.ts` reads them and writes them through the ordinary
driver contract, exactly as a real agent's file writes are recorded.

What they are for:

* **proving a case is solvable.** A case whose fixture nobody has ever made green is a case that
  might be impossible, and a benchmark full of those measures nothing.
* **proving a case DISCRIMINATES.** The same test writes a no-op, a forbidden test edit and one or
  two plausible-but-wrong answers, and asserts each lands where it should. A hidden check that
  passes for a wrong answer is a hidden check that is not doing its job, and this is where that is
  found out.

A wrong answer is expressed as a small edit to the solution below it rather than as a second copy of
it, so the two cannot drift apart and a reader can see exactly what makes it wrong.
