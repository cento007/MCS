import { describe, expect, it } from 'vitest';
import {
  frontMatterValue,
  mergeFrontMatter,
  parseFrontMatter,
  renderFrontMatter,
} from './front-matter.js';
import {
  extraSections,
  noteHash,
  noteIdentity,
  parseNote,
  renderNote,
  sectionText,
} from './note.js';

const ID = '0199a3f1-6c2e-7a10-9f01-3d4e5f607182';

describe('front matter', () => {
  it('round-trips an operator property this engine knows nothing about', () => {
    const source = [
      '---',
      'mcId: "old"',
      'cssclasses:',
      '  - wide-table',
      '  - no-margins',
      'aliases: [ADR 7, The queue decision]',
      '---',
      '',
      '# Title',
      '',
    ].join('\n');

    const { frontMatter, body } = parseFrontMatter(source);
    const merged = mergeFrontMatter(frontMatter, [['mcId', ID]]);
    const rendered = renderFrontMatter(merged);

    expect(rendered).toContain('cssclasses:');
    expect(rendered).toContain('  - wide-table');
    expect(rendered).toContain('  - no-margins');
    expect(rendered).toContain('aliases: [ADR 7, The queue decision]');
    expect(rendered).toContain(`mcId: "${ID}"`);
    expect(rendered).not.toContain('mcId: "old"');
    expect(body.trim()).toBe('# Title');
  });

  it('keeps a managed key in the position the operator left it', () => {
    const { frontMatter } = parseFrontMatter('---\nfirst: 1\nstatus: "proposed"\nlast: 2\n---\n');
    const rendered = renderFrontMatter(
      mergeFrontMatter(frontMatter, [
        ['status', 'accepted'],
        ['mcId', ID],
      ]),
    );

    const lines = rendered.split('\n');
    expect(lines.indexOf('status: "accepted"')).toBeLessThan(lines.indexOf('last: 2'));
    // A key that was not there is appended rather than inserted somewhere arbitrary.
    expect(lines.indexOf(`mcId: "${ID}"`)).toBeGreaterThan(lines.indexOf('last: 2'));
  });

  it('removes a managed key whose value became null', () => {
    const { frontMatter } = parseFrontMatter('---\nsupersededBy: "abc"\nkeep: 1\n---\n');
    const rendered = renderFrontMatter(mergeFrontMatter(frontMatter, [['supersededBy', null]]));

    expect(rendered).not.toContain('supersededBy');
    expect(rendered).toContain('keep: 1');
  });

  it('treats an unterminated fence as body, not as front matter', () => {
    const source = '---\nthis note starts with a horizontal rule\n';
    const parsed = parseFrontMatter(source);

    expect(parsed.frontMatter).toBeNull();
    expect(parsed.body).toBe(source);
  });

  it('reads a scalar with or without quotes and refuses a block value', () => {
    const { frontMatter } = parseFrontMatter('---\nquoted: "a"\nbare: b\nblock:\n  - c\n---\n');

    expect(frontMatterValue(frontMatter, 'quoted')).toBe('a');
    expect(frontMatterValue(frontMatter, 'bare')).toBe('b');
    expect(frontMatterValue(frontMatter, 'block')).toBeNull();
    expect(frontMatterValue(frontMatter, 'absent')).toBeNull();
  });

  it('quotes a title that YAML would otherwise read as a boolean or a mapping', () => {
    const rendered = renderFrontMatter(
      mergeFrontMatter(null, [
        ['project', 'no'],
        ['note', 'Yes: use pg-boss'],
      ]),
    );

    const reparsed = parseFrontMatter(`${rendered}\n`);
    expect(frontMatterValue(reparsed.frontMatter, 'project')).toBe('no');
    expect(frontMatterValue(reparsed.frontMatter, 'note')).toBe('Yes: use pg-boss');
  });
});

describe('note structure', () => {
  const note = parseNote(
    [
      '---',
      `mcId: "${ID}"`,
      'mcType: "adr"',
      '---',
      '',
      '# Use pg-boss for the job queue',
      '',
      'A stray line before any section.',
      '',
      '## Context',
      '',
      'Redis has no native Windows build.',
      '',
      '## Notes to self',
      '',
      'Ask Marc about the retry budget.',
      '',
    ].join('\n'),
  );

  it('reads the identity from front matter, not from the file name', () => {
    expect(noteIdentity(note)).toEqual({ entityId: ID, entityType: 'adr' });
  });

  it('refuses an identity whose type is not a known entity type', () => {
    const bogus = parseNote(`---\nmcId: "${ID}"\nmcType: "sprocket"\n---\n\n# x\n`);
    expect(noteIdentity(bogus)).toBeNull();
  });

  it('splits the title, the preamble and the level-2 sections', () => {
    expect(note.title).toBe('Use pg-boss for the job queue');
    expect(note.preamble).toEqual(['A stray line before any section.']);
    expect(note.sections.map((section) => section.heading)).toEqual(['Context', 'Notes to self']);
    expect(sectionText(note, 'context')).toBe('Redis has no native Windows build.');
  });

  it('reports the operator sections that are not ours', () => {
    const extras = extraSections(note, ['Context', 'Decision']);
    expect(extras.map((section) => section.heading)).toEqual(['Notes to self']);
  });

  it('re-emits operator sections after the canonical ones', () => {
    const rendered = renderNote({
      frontMatter: [['mcId', ID]],
      existing: note.frontMatter,
      title: 'Use pg-boss for the job queue',
      sections: [{ heading: 'Context', body: 'Rewritten context.' }],
      extras: extraSections(note, ['Context']),
    });

    expect(rendered).toContain('## Context\n\nRewritten context.');
    expect(rendered).toContain('## Notes to self\n\nAsk Marc about the retry budget.');
    expect(rendered.indexOf('## Context')).toBeLessThan(rendered.indexOf('## Notes to self'));
  });

  it('hashes CRLF and LF identically — an editor rewriting line endings is not a change', () => {
    const lf = '---\nmcId: "x"\n---\n\n# T\n\n## Context\n\nBody\n';
    expect(noteHash(lf.replace(/\n/g, '\r\n'))).toBe(noteHash(lf));
  });

  it('parses a note with no front matter at all', () => {
    const plain = parseNote('# Hand written\n\n## Context\n\nSomething.\n');
    expect(noteIdentity(plain)).toBeNull();
    expect(plain.title).toBe('Hand written');
    expect(sectionText(plain, 'Context')).toBe('Something.');
  });
});
