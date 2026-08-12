import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { accessibleToolName, ToolCallBlock } from './ToolCallBlock.js';

/**
 * TDS 06 §7.4 item 4 — the collapsed row must be comprehensible without expanding it, for
 * screen-reader users exactly as it is for sighted ones.
 */

describe('accessibleToolName', () => {
  it('matches the specification example verbatim', () => {
    expect(accessibleToolName('Read', 'packages/shared/queue.ts', 'ok', 1.2)).toBe(
      'tool Read, packages/shared/queue.ts, completed in 1.2 seconds',
    );
  });

  it('reads "running" in flight and "failed" on error', () => {
    expect(accessibleToolName('Edit', 'a.ts', 'running', null)).toBe('tool Edit, a.ts, running');
    expect(accessibleToolName('Bash', 'ls', 'error', 0.4)).toBe('tool Bash, ls, failed');
  });

  it('omits the duration when it cannot be derived, rather than inventing one', () => {
    expect(accessibleToolName('Read', 'a.ts', 'ok', null)).toBe('tool Read, a.ts, completed');
  });
});

describe('<ToolCallBlock>', () => {
  it('is a collapsed disclosure button carrying the whole summary', () => {
    render(
      <ToolCallBlock
        toolName="Read"
        input={{ file_path: 'packages/shared/queue.ts' }}
        result={{ output: 'contents', isError: false, durationSeconds: 1.2 }}
        status="ok"
      />,
    );

    const button = screen.getByRole('button', {
      name: 'tool Read, packages/shared/queue.ts, completed in 1.2 seconds',
    });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('contents')).toBeNull();
  });

  it('reveals input and output on expand', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallBlock
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: 'x' }}
        result={{ output: 'patched', isError: false, durationSeconds: 0.3 }}
        status="ok"
      />,
    );

    await user.click(screen.getByRole('button', { name: /tool Edit/ }));
    expect(screen.getByRole('button', { name: /tool Edit/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('patched')).toBeInTheDocument();
    expect(screen.getByText(/"file_path": "a.ts"/)).toBeInTheDocument();
  });

  it('clamps very long output behind an explicit "Show full"', async () => {
    const user = userEvent.setup();
    const output = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n');
    render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'ls' }}
        result={{ output, isError: false, durationSeconds: 2 }}
        status="ok"
      />,
    );

    await user.click(screen.getByRole('button', { name: /tool Bash/ }));
    expect(
      screen.getByRole('button', { name: 'Show full output (120 lines)' }),
    ).toBeInTheDocument();
  });
});
