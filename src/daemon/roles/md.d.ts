/**
 * Role prompts are markdown files so they can be read and edited as prose, and
 * text imports so they are embedded in the compiled binary rather than looked
 * up on disk at run time — a single-file binary has no `src/` to read from.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
