import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api/client';
import type { CsvRow } from '../../types/csvFile';
import { axiosError, createMessageApi, makeRow, ok } from '../../test/helpers';
import EditRowModal from '../EditRowModal';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
}));

const mockedGet = vi.mocked(api.get);
const mockedPut = vi.mocked(api.put);

const CONFLICT_TEXT = 'Not saved: someone else changed this row while you were editing.';
const STALE_TEXT = 'This row has changed since you opened it. Saving will fail until you load the latest values.';

const latestRow = makeRow({
  version: 2,
  name: 'Latest name',
  body: 'Latest body',
  email: 'latest@example.com',
  post_id: 99,
});

const setup = (props: { row?: CsvRow; stale?: boolean } = {}) => {
  const row = props.row ?? makeRow();
  const callbacks = {
    messageApi: createMessageApi(),
    getHeaders: vi.fn(() => ({ 'X-Client-Id': 'client-1' })),
    onClose: vi.fn(),
    onRowLoaded: vi.fn(),
    onRowDeleted: vi.fn(),
  };
  const user = userEvent.setup();
  const ui = (stale: boolean) => <EditRowModal row={row} stale={stale} {...callbacks} />;
  const view = render(ui(props.stale ?? false));
  return {
    ...callbacks,
    row,
    user,
    setStale: (stale: boolean) => view.rerender(ui(stale)),
    okButton: () => screen.getByRole('button', { name: 'OK' }),
    nameInput: () => screen.getByLabelText('Name') as HTMLInputElement,
  };
};

const lastPutBody = () => mockedPut.mock.calls.at(-1)?.[1] as Partial<CsvRow>;

const triggerConflict = async (ctx: ReturnType<typeof setup>, typed = 'Typed name') => {
  mockedPut.mockRejectedValueOnce(axiosError(409));
  await ctx.user.clear(ctx.nameInput());
  await ctx.user.type(ctx.nameInput(), typed);
  await ctx.user.click(ctx.okButton());
  await screen.findByText(CONFLICT_TEXT);
};

describe('EditRowModal', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPut.mockReset();
  });

  it('prefills the form from the row', () => {
    const ctx = setup();
    expect(ctx.nameInput()).toHaveValue('Alice');
    expect(screen.getByLabelText('Body')).toHaveValue('Hello world');
    expect(screen.getByLabelText('Email')).toHaveValue('alice@example.com');
    expect(screen.getByLabelText('Post Id')).toHaveValue(10);
    expect(screen.getByText('Edit Row')).toBeInTheDocument();
  });

  it('closes without a PUT when OK is clicked with no changes', async () => {
    const ctx = setup();
    await ctx.user.click(ctx.okButton());
    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it('closes without a PUT when Cancel is clicked', async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ctx.onClose).toHaveBeenCalledTimes(1);
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it('sends a PUT with the form values, version and client headers after editing', async () => {
    const ctx = setup();
    const saved = makeRow({ name: 'Bob', version: 2 });
    mockedPut.mockResolvedValueOnce(ok(saved));

    await ctx.user.clear(ctx.nameInput());
    await ctx.user.type(ctx.nameInput(), 'Bob');
    await ctx.user.click(ctx.okButton());

    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedPut).toHaveBeenCalledWith(
      '/row/1',
      expect.objectContaining({
        id: 1,
        version: 1,
        name: 'Bob',
        body: 'Hello world',
        email: 'alice@example.com',
      }),
      { headers: { 'X-Client-Id': 'client-1' } },
    );
    expect(ctx.getHeaders).toHaveBeenCalled();
    expect(ctx.onRowLoaded).toHaveBeenCalledWith(saved);
    expect(ctx.messageApi.success).toHaveBeenCalledWith('Updated');
  });

  it('shows the conflict alert and disables OK when the PUT returns 409', async () => {
    const ctx = setup();
    await triggerConflict(ctx);

    expect(screen.getByRole('alert')).toHaveTextContent(CONFLICT_TEXT);
    expect(ctx.okButton()).toBeDisabled();
    expect(ctx.onClose).not.toHaveBeenCalled();
    expect(ctx.onRowLoaded).not.toHaveBeenCalled();
  });

  it('shows the stale warning and disables OK when stale is true', () => {
    const ctx = setup({ stale: true });
    expect(screen.getByText(STALE_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CONFLICT_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load latest values' })).toBeInTheDocument();
    expect(ctx.okButton()).toBeDisabled();
  });

  it('does not show an alert or disable OK when not stale and no conflict', () => {
    const ctx = setup();
    expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(CONFLICT_TEXT)).not.toBeInTheDocument();
    expect(ctx.okButton()).toBeEnabled();
  });

  it('loads the latest values, shows them with Replace buttons and reports the row', async () => {
    const ctx = setup();
    await triggerConflict(ctx);
    mockedGet.mockResolvedValueOnce(ok(latestRow));

    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));

    await screen.findByText('New Values');
    expect(mockedGet).toHaveBeenCalledWith('/row/1');
    expect(ctx.onRowLoaded).toHaveBeenCalledWith(latestRow);
    expect(screen.getByText('Name: Latest name')).toBeInTheDocument();
    expect(screen.getByText('Body: Latest body')).toBeInTheDocument();
    expect(screen.getByText('Email: latest@example.com')).toBeInTheDocument();
    expect(screen.getByText('Post Id: 99')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Replace' })).toHaveLength(4);
    expect(screen.queryByText(CONFLICT_TEXT)).not.toBeInTheDocument();
    expect(ctx.okButton()).toBeEnabled();
  });

  it('keeps typed values after loading the latest values', async () => {
    const ctx = setup();
    await triggerConflict(ctx, 'My edit');
    mockedGet.mockResolvedValueOnce(ok(latestRow));

    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));
    await screen.findByText('New Values');

    expect(ctx.nameInput()).toHaveValue('My edit');
    expect(screen.getByLabelText('Body')).toHaveValue('Hello world');
  });

  it('sends the latest version on the next save after loading the latest values', async () => {
    const ctx = setup();
    await triggerConflict(ctx, 'My edit');
    mockedGet.mockResolvedValueOnce(ok(latestRow));
    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));
    await screen.findByText('New Values');

    const saved = makeRow({ name: 'My edit', version: 3 });
    mockedPut.mockResolvedValueOnce(ok(saved));
    await ctx.user.click(ctx.okButton());

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(2));
    expect(lastPutBody()).toEqual(expect.objectContaining({ name: 'My edit', version: 2 }));
    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(ctx.onRowLoaded).toHaveBeenLastCalledWith(saved);
  });

  it('copies a field with Replace and sends a PUT when that is the only change', async () => {
    const ctx = setup({ stale: true });
    mockedGet.mockResolvedValueOnce(ok(latestRow));
    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));
    await screen.findByText('New Values');
    ctx.setStale(false);

    const nameRow = screen.getByText('Name: Latest name').parentElement!;
    await ctx.user.click(within(nameRow).getByRole('button', { name: 'Replace' }));
    expect(ctx.nameInput()).toHaveValue('Latest name');

    mockedPut.mockResolvedValueOnce(ok(latestRow));
    await ctx.user.click(ctx.okButton());

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    expect(lastPutBody()).toEqual(expect.objectContaining({ name: 'Latest name', version: 2, body: 'Hello world' }));
    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
  });

  it('copies each field with its own Replace button', async () => {
    const ctx = setup({ stale: true });
    mockedGet.mockResolvedValueOnce(ok(latestRow));
    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));
    await screen.findByText('New Values');

    for (const label of ['Body: Latest body', 'Email: latest@example.com', 'Post Id: 99']) {
      await ctx.user.click(within(screen.getByText(label).parentElement!).getByRole('button', { name: 'Replace' }));
    }

    expect(ctx.nameInput()).toHaveValue('Alice');
    expect(screen.getByLabelText('Body')).toHaveValue('Latest body');
    expect(screen.getByLabelText('Email')).toHaveValue('latest@example.com');
    expect(screen.getByLabelText('Post Id')).toHaveValue(99);
  });

  it('treats a PUT 404 as a deleted row', async () => {
    const ctx = setup();
    mockedPut.mockRejectedValueOnce(axiosError(404));
    await ctx.user.type(ctx.nameInput(), 'x');
    await ctx.user.click(ctx.okButton());

    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(ctx.messageApi.error).toHaveBeenCalledWith('This row has been deleted.');
    expect(ctx.onRowDeleted).toHaveBeenCalledWith(1);
  });

  it('treats a Load latest 404 as a deleted row', async () => {
    const ctx = setup({ stale: true });
    mockedGet.mockRejectedValueOnce(axiosError(404));
    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));

    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(ctx.messageApi.error).toHaveBeenCalledWith('This row has been deleted.');
    expect(ctx.onRowDeleted).toHaveBeenCalledWith(1);
    expect(ctx.onRowLoaded).not.toHaveBeenCalled();
  });

  it('shows a generic error when Load latest fails for another reason', async () => {
    const ctx = setup({ stale: true });
    mockedGet.mockRejectedValueOnce(axiosError(500));
    await ctx.user.click(screen.getByRole('button', { name: 'Load latest values' }));

    await waitFor(() => expect(ctx.messageApi.error).toHaveBeenCalledWith('Failed to load the latest values.'));
    expect(ctx.onClose).not.toHaveBeenCalled();
    expect(ctx.onRowDeleted).not.toHaveBeenCalled();
  });

  it("shows the server's error message when the PUT returns 400", async () => {
    const ctx = setup();
    mockedPut.mockRejectedValueOnce(axiosError(400, { error: 'Email is invalid.' }));
    await ctx.user.type(ctx.nameInput(), 'x');
    await ctx.user.click(ctx.okButton());

    await waitFor(() => expect(ctx.messageApi.error).toHaveBeenCalledWith('Email is invalid.'));
    expect(ctx.onClose).not.toHaveBeenCalled();
    expect(ctx.onRowDeleted).not.toHaveBeenCalled();
  });

  it('shows a generic error when the PUT fails for another reason', async () => {
    const ctx = setup();
    mockedPut.mockRejectedValueOnce(axiosError(500));
    await ctx.user.type(ctx.nameInput(), 'x');
    await ctx.user.click(ctx.okButton());

    await waitFor(() => expect(ctx.messageApi.error).toHaveBeenCalledWith('Failed to update row.'));
    expect(ctx.onClose).not.toHaveBeenCalled();
  });
});
