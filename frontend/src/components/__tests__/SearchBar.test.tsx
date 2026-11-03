import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SearchBar from '../SearchBar';

const setup = () => {
  const onSearch = vi.fn();
  const user = userEvent.setup();
  render(<SearchBar onSearch={onSearch} />);
  return {
    onSearch,
    user,
    input: screen.getByPlaceholderText('Search By Name, Body or Email'),
    startInput: screen.getByPlaceholderText('Start date'),
    endInput: screen.getByPlaceholderText('End date'),
    searchButton: screen.getByRole('button', { name: 'Search' }),
  };
};

const startOfDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
const endOfDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();

describe('SearchBar', () => {
  it('calls onSearch with the trimmed text when the Search button is clicked', async () => {
    const { user, input, searchButton, onSearch } = setup();
    await user.type(input, '  alice  ');
    await user.click(searchButton);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith({ search: 'alice', from: undefined, to: undefined });
  });

  it('calls onSearch when Enter is pressed in the search input', async () => {
    const { user, input, onSearch } = setup();
    await user.type(input, 'bob{Enter}');
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith({ search: 'bob', from: undefined, to: undefined });
  });

  it('sends search undefined when the text is empty', async () => {
    const { user, searchButton, onSearch } = setup();
    await user.click(searchButton);
    expect(onSearch).toHaveBeenCalledWith({ search: undefined, from: undefined, to: undefined });
  });

  it('sends search undefined when the text is only whitespace', async () => {
    const { user, input, onSearch } = setup();
    await user.type(input, '    {Enter}');
    expect(onSearch).toHaveBeenCalledWith({ search: undefined, from: undefined, to: undefined });
  });

  it('sends from as the start of the first day and to as the end of the last day', async () => {
    const { user, startInput, endInput, searchButton, onSearch } = setup();
    await user.click(startInput);
    await user.type(startInput, '2024-03-05{Enter}');
    await user.click(endInput);
    await user.type(endInput, '2024-03-09{Enter}');
    await user.click(searchButton);
    expect(onSearch).toHaveBeenLastCalledWith({
      search: undefined,
      from: startOfDay(2024, 3, 5),
      to: endOfDay(2024, 3, 9),
    });
  });

  it('allows an open-ended range with only a start date', async () => {
    const { user, startInput, searchButton, onSearch } = setup();
    await user.click(startInput);
    await user.type(startInput, '2024-03-05{Enter}');
    await user.click(document.body);
    await user.click(searchButton);
    expect(onSearch).toHaveBeenLastCalledWith({ search: undefined, from: startOfDay(2024, 3, 5), to: undefined });
  });

  it('allows an open-ended range with only an end date', async () => {
    const { user, endInput, searchButton, onSearch } = setup();
    await user.click(endInput);
    await user.type(endInput, '2024-03-09{Enter}');
    await user.click(document.body);
    await user.click(searchButton);
    expect(onSearch).toHaveBeenLastCalledWith({ search: undefined, from: undefined, to: endOfDay(2024, 3, 9) });
  });

  it('combines text and date range filters', async () => {
    const { user, input, startInput, endInput, searchButton, onSearch } = setup();
    await user.type(input, ' carol ');
    await user.click(startInput);
    await user.type(startInput, '2024-01-01{Enter}');
    await user.click(endInput);
    await user.type(endInput, '2024-01-31{Enter}');
    await user.click(searchButton);
    expect(onSearch).toHaveBeenLastCalledWith({
      search: 'carol',
      from: startOfDay(2024, 1, 1),
      to: endOfDay(2024, 1, 31),
    });
  });
});
