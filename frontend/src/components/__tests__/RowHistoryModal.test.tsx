import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api/client';
import type { CsvRow, RowHistory } from '../../types/csvFile';
import { axiosError, createMessageApi, deferred, makeRow, ok } from '../../test/helpers';
import RowHistoryModal from '../RowHistoryModal';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
}));

const mockedGet = vi.mocked(api.get);

const current = makeRow({ id: 5, version: 3, name: 'Carol', email: 'carol@example.com', body: 'Third', post_id: 1 });

const history: RowHistory[] = [
  {
    id: 21,
    row_id: 5,
    version: 2,
    name: 'Bob',
    email: 'carol@example.com',
    body: 'Second',
    post_id: 1,
    date_created: '2024-01-01T00:00:00.000Z',
    date_archived: '2024-02-02T10:00:00.000Z',
  },
  {
    id: 20,
    row_id: 5,
    version: 1,
    name: 'Alice',
    email: 'carol@example.com',
    body: 'Second',
    post_id: 2,
    date_created: '2024-01-01T00:00:00.000Z',
    date_archived: '2024-01-15T08:30:00.000Z',
  },
];

const routeGet = (rowResult: Promise<unknown>, historyResult: Promise<unknown>) => {
  mockedGet.mockImplementation(((url: string) => {
    if (url === '/row/5') return rowResult;
    if (url === '/row/5/history') return historyResult;
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  }) as typeof api.get);
};

const setup = () => {
  const props = {
    row: makeRow({ id: 5, version: 2, name: 'Stale name' }),
    messageApi: createMessageApi(),
    onClose: vi.fn(),
    onRowLoaded: vi.fn(),
    onRowDeleted: vi.fn(),
  };
  const view = render(<RowHistoryModal {...props} />);
  return { ...props, ...view };
};

const versionRows = () => {
  const dialog = screen.getByRole('dialog');
  return Array.from(dialog.querySelectorAll<HTMLTableRowElement>('tr[data-row-key]'));
};

const cellTexts = (row: HTMLTableRowElement) => Array.from(row.cells).map((cell) => cell.textContent);

const highlightedValues = (row: HTMLTableRowElement) =>
  Array.from(row.querySelectorAll('.ant-typography-success')).map((el) => el.textContent);

describe('RowHistoryModal', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('fetches the row and its history and reports the current row', async () => {
    routeGet(Promise.resolve(ok(current)), Promise.resolve(ok(history)));
    const ctx = setup();

    expect(screen.getByText('History of row 5')).toBeInTheDocument();
    await waitFor(() => expect(ctx.onRowLoaded).toHaveBeenCalledWith(current));
    expect(mockedGet).toHaveBeenCalledWith('/row/5');
    expect(mockedGet).toHaveBeenCalledWith('/row/5/history');
    expect(ctx.onRowLoaded).toHaveBeenCalledTimes(1);
    expect(ctx.onClose).not.toHaveBeenCalled();
  });

  it('shows the current version first, then history newest first with versions and dates', async () => {
    routeGet(Promise.resolve(ok(current)), Promise.resolve(ok(history)));
    setup();

    await waitFor(() => expect(versionRows()).toHaveLength(3));
    const [first, second, third] = versionRows();

    expect(cellTexts(first).slice(0, 2)).toEqual(['3', '-']);
    expect(first).toHaveTextContent('Carol');
    expect(cellTexts(second).slice(0, 2)).toEqual(['2', new Date(history[0].date_archived).toLocaleString()]);
    expect(second).toHaveTextContent('Bob');
    expect(cellTexts(third).slice(0, 2)).toEqual(['1', new Date(history[1].date_archived).toLocaleString()]);
    expect(third).toHaveTextContent('Alice');
    expect(screen.queryByText('Stale name')).not.toBeInTheDocument();
  });

  it('highlights values that differ from the next-older version', async () => {
    routeGet(Promise.resolve(ok(current)), Promise.resolve(ok(history)));
    setup();

    await waitFor(() => expect(versionRows()).toHaveLength(3));
    const [first, second, third] = versionRows();

    expect(highlightedValues(first).sort()).toEqual(['Carol', 'Third']);
    expect(highlightedValues(second).sort()).toEqual(['1', 'Bob']);
    expect(highlightedValues(third)).toEqual([]);
    expect(within(first).getByText('Carol').closest('strong')).not.toBeNull();
  });

  it('shows only the current version when there is no history', async () => {
    routeGet(Promise.resolve(ok(current)), Promise.resolve(ok([])));
    setup();

    await waitFor(() => expect(versionRows()).toHaveLength(1));
    expect(highlightedValues(versionRows()[0])).toEqual([]);
  });

  it('reports a deleted row and closes on 404', async () => {
    routeGet(Promise.reject(axiosError(404)), Promise.resolve(ok(history)));
    const ctx = setup();

    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(ctx.messageApi.error).toHaveBeenCalledWith('This row has been deleted.');
    expect(ctx.onRowDeleted).toHaveBeenCalledWith(5);
    expect(ctx.onRowLoaded).not.toHaveBeenCalled();
  });

  it('shows an error and closes on other failures', async () => {
    routeGet(Promise.resolve(ok(current)), Promise.reject(axiosError(500)));
    const ctx = setup();

    await waitFor(() => expect(ctx.onClose).toHaveBeenCalledTimes(1));
    expect(ctx.messageApi.error).toHaveBeenCalledWith('Failed to load row history.');
    expect(ctx.onRowDeleted).not.toHaveBeenCalled();
    expect(ctx.onRowLoaded).not.toHaveBeenCalled();
  });

  it('calls nothing when unmounted before the responses arrive', async () => {
    const rowReq = deferred<AxiosResponse<CsvRow>>();
    const historyReq = deferred<AxiosResponse<RowHistory[]>>();
    routeGet(rowReq.promise, historyReq.promise);
    const ctx = setup();

    ctx.unmount();
    await act(async () => {
      rowReq.resolve(ok(current));
      historyReq.resolve(ok(history));
      await Promise.resolve();
    });

    expect(ctx.onRowLoaded).not.toHaveBeenCalled();
    expect(ctx.onClose).not.toHaveBeenCalled();
    expect(ctx.messageApi.error).not.toHaveBeenCalled();
  });

  it('calls nothing when unmounted before a failing response arrives', async () => {
    const rowReq = deferred<AxiosResponse<CsvRow>>();
    routeGet(rowReq.promise, Promise.resolve(ok(history)));
    const ctx = setup();

    ctx.unmount();
    await act(async () => {
      rowReq.reject(axiosError(404));
      await Promise.resolve();
    });

    expect(ctx.onRowDeleted).not.toHaveBeenCalled();
    expect(ctx.onClose).not.toHaveBeenCalled();
    expect(ctx.messageApi.error).not.toHaveBeenCalled();
  });
});
