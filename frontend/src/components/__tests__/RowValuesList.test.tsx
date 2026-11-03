import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RowValuesList from '../RowValuesList';
import type { RowValues } from '../RowValuesList';

const base: RowValues = { post_id: 7, name: 'Alice', email: 'alice@example.com', body: 'Hello' };

const valueElement = (text: string | number) => {
  const el = screen.getByText(String(text)).closest('.ant-typography');
  if (!el) throw new Error(`No typography element for ${text}`);
  return el;
};

const isHighlighted = (text: string | number, type: 'danger' | 'success') => {
  const el = valueElement(text);
  return el.classList.contains(`ant-typography-${type}`) && el.querySelector('strong') !== null;
};

describe('RowValuesList', () => {
  it('renders a dash when row is null', () => {
    render(<RowValuesList row={null} other={base} highlight='danger' />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/name:/)).not.toBeInTheDocument();
  });

  it('renders post_id, name, email and body with labels', () => {
    render(<RowValuesList row={base} other={null} highlight='success' />);
    for (const label of ['post_id:', 'name:', 'email:', 'body:']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(valueElement(7)).toBeInTheDocument();
    expect(valueElement('Alice')).toBeInTheDocument();
    expect(valueElement('alice@example.com')).toBeInTheDocument();
    expect(valueElement('Hello')).toBeInTheDocument();
  });

  it('highlights nothing when other is null', () => {
    const { container } = render(<RowValuesList row={base} other={null} highlight='success' />);
    expect(container.querySelector('.ant-typography-success')).toBeNull();
    expect(container.querySelector('.ant-typography-danger')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
  });

  it('highlights nothing when other has identical values', () => {
    const { container } = render(<RowValuesList row={base} other={{ ...base }} highlight='success' />);
    expect(container.querySelector('.ant-typography-success')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
  });

  it('highlights only the fields that differ, using the success type', () => {
    render(<RowValuesList row={{ ...base, name: 'Bob', post_id: 8 }} other={base} highlight='success' />);
    expect(isHighlighted('Bob', 'success')).toBe(true);
    expect(isHighlighted(8, 'success')).toBe(true);
    expect(isHighlighted('alice@example.com', 'success')).toBe(false);
    expect(isHighlighted('Hello', 'success')).toBe(false);
  });

  it('highlights differing fields with the danger type', () => {
    const { container } = render(
      <RowValuesList row={{ ...base, email: 'old@example.com' }} other={base} highlight='danger' />,
    );
    expect(isHighlighted('old@example.com', 'danger')).toBe(true);
    expect(container.querySelectorAll('.ant-typography-danger')).toHaveLength(1);
    expect(container.querySelector('.ant-typography-success')).toBeNull();
  });
});
