import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import api from '../api/client';
import type { CsvRow, RowFilters, RowResponse, SocketMessage } from '../types/csvFile';
import { makeRow, ok } from '../test/helpers';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
}));

const mockedGet = vi.mocked(api.get);
const mockedPut = vi.mocked(api.put);
const mockedDelete = vi.mocked(api.delete);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  emitOpen() {
    act(() => this.onopen?.(new Event('open')));
  }

  emitMessage(message: SocketMessage) {
    act(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) })));
  }

  emitClose() {
    act(() => this.onclose?.(new CloseEvent('close')));
  }
}

const latestSocket = () => FakeWebSocket.instances.at(-1)!;

type RowParams = { page: number; limit: number } & RowFilters;

const response = (data: CsvRow[], totalItems: number, totalPages: number, page = 1): RowResponse => ({
  data,
  metadata: {
    totalItems,
    totalPages,
    currentPage: page,
    pageSize: 100,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  },
});

const pageOneRows = [
  makeRow({ id: 1, name: 'Alice' }),
  makeRow({ id: 2, name: 'Bob', email: 'bob@example.com' }),
  makeRow({ id: 3, name: 'Carol', email: 'carol@example.com' }),
];

const serveRows = (handler: (params: RowParams) => RowResponse) => {
  mockedGet.mockImplementation(((url: string, config?: { params?: RowParams }) => {
    if (url === '/row') return Promise.resolve(ok(handler(config!.params!)));
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  }) as typeof api.get);
};

const rowCalls = () =>
  mockedGet.mock.calls.filter(([url]) => url === '/row').map(([, config]) => (config as { params: RowParams }).params);

const NoMotion = ({ children }: { children: ReactNode }) => (
  <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
);

const renderApp = async () => {
  const user = userEvent.setup();
  const view = render(<App />, { wrapper: NoMotion });
  await screen.findByText('Alice');
  return { user, ...view };
};

const tableRow = (id: number) => {
  const row = document.querySelector<HTMLElement>(`.ant-table [data-row-key="${id}"]`);
  if (!row) throw new Error(`Row ${id} not rendered`);
  return row;
};

const rowButtons = (id: number) => {
  const row = within(tableRow(id));
  return {
    edit: row.getByRole('button', { name: 'edit' }),
    history: row.getByRole('button', { name: 'field-time' }),
    remove: row.getByRole('button', { name: 'delete' }),
  };
};

describe('App', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPut.mockReset();
    mockedDelete.mockReset();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    serveRows(() => response(pageOneRows, 3, 1));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('loading rows', () => {
    it('GETs the first page of rows with the default page size and renders them', async () => {
      await renderApp();

      expect(mockedGet).toHaveBeenCalledWith('/row', { params: { page: 1, limit: 100 } });
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
      expect(screen.getByText('Carol')).toBeInTheDocument();
    });

    it('refetches the last page when the requested page is past the end', async () => {
      serveRows(({ page }) => {
        if (page === 1) return response(pageOneRows, 250, 3, 1);
        if (page === 3) return response([], 150, 2, 3);
        return response([makeRow({ id: 150, name: 'Last page row' })], 150, 2, page);
      });
      const { user } = await renderApp();

      await user.click(document.querySelector<HTMLElement>('.ant-pagination-item-3')!);

      expect(await screen.findByText('Last page row')).toBeInTheDocument();
      expect(rowCalls().map((params) => params.page)).toEqual([1, 3, 2]);
      expect(rowCalls().at(-1)).toEqual({ page: 2, limit: 100 });
    });

    it('does not refetch when the first page is empty', async () => {
      serveRows(() => response([], 0, 0, 1));
      render(<App />, { wrapper: NoMotion });

      await waitFor(() => expect(rowCalls()).toHaveLength(1));
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(rowCalls()).toHaveLength(1);
    });

    it('shows an error message when loading rows fails', async () => {
      mockedGet.mockRejectedValue(new Error('down'));
      render(<App />, { wrapper: NoMotion });

      expect(await screen.findByText('Failed to load rows.')).toBeInTheDocument();
    });
  });

  describe('searching', () => {
    it('refetches from page 1 with the search filters', async () => {
      serveRows(({ page }) => response(pageOneRows, 250, 3, page));
      const { user } = await renderApp();
      await user.click(document.querySelector<HTMLElement>('.ant-pagination-item-2')!);
      await waitFor(() => expect(rowCalls().at(-1)?.page).toBe(2));

      await user.type(screen.getByPlaceholderText('Search By Name, Body or Email'), ' bob ');
      await user.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => expect(rowCalls().at(-1)).toEqual({ page: 1, limit: 100, search: 'bob' }));
    });
  });

  describe('websocket', () => {
    it('connects to the ws: URL for the API base', async () => {
      await renderApp();

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(latestSocket().url).toBe(`ws://${window.location.host}/api/ws`);
      expect(screen.getByText('Websocket: attempting')).toBeInTheDocument();
    });

    it('sends the client id from the connected message as X-Client-Id when deleting', async () => {
      const { user } = await renderApp();
      latestSocket().emitOpen();
      latestSocket().emitMessage({ type: 'connected', clientId: 'client-42' });
      expect(screen.getByText('Websocket: connected')).toBeInTheDocument();
      mockedDelete.mockResolvedValueOnce(ok({}));

      await user.click(rowButtons(1).remove);
      expect(await screen.findByText('Delete this row?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'OK' }));

      await waitFor(() =>
        expect(mockedDelete).toHaveBeenCalledWith('/row/1', { headers: { 'X-Client-Id': 'client-42' } }),
      );
    });

    it('sends the client id as X-Client-Id when saving an edit', async () => {
      const { user } = await renderApp();
      latestSocket().emitMessage({ type: 'connected', clientId: 'client-42' });
      mockedPut.mockResolvedValueOnce(ok(makeRow({ id: 1, name: 'Alice 2', version: 2 })));

      await user.click(rowButtons(1).edit);
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Name'), ' 2');
      await user.click(within(dialog).getByRole('button', { name: 'OK' }));

      await waitFor(() =>
        expect(mockedPut).toHaveBeenCalledWith(
          '/row/1',
          expect.objectContaining({ name: 'Alice 2', version: 1 }),
          { headers: { 'X-Client-Id': 'client-42' } },
        ),
      );
      expect(await screen.findByText('Alice 2')).toBeInTheDocument();
    });

    it('sends no X-Client-Id before the connected message arrives', async () => {
      const { user } = await renderApp();
      mockedDelete.mockResolvedValueOnce(ok({}));

      await user.click(rowButtons(1).remove);
      await user.click(await screen.findByRole('button', { name: 'OK' }));

      await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('/row/1', { headers: {} }));
    });

    it('tags rows from rows_updated as Updated and puts a dot on their history button', async () => {
      await renderApp();
      latestSocket().emitMessage({ type: 'rows_updated', ids: [2] });

      expect(within(tableRow(2)).getByText('Updated')).toBeInTheDocument();
      expect(tableRow(2).querySelector('.ant-badge-dot')).not.toBeNull();
      expect(within(tableRow(1)).queryByText('Updated')).not.toBeInTheDocument();
      expect(tableRow(1).querySelector('.ant-badge-dot')).toBeNull();
      expect(rowButtons(2).edit).toBeEnabled();
    });

    it('tags rows from rows_deleted as Deleted and disables their buttons', async () => {
      await renderApp();
      latestSocket().emitMessage({ type: 'rows_deleted', ids: [3] });

      expect(within(tableRow(3)).getByText('Deleted')).toBeInTheDocument();
      const deleted = rowButtons(3);
      expect(deleted.edit).toBeDisabled();
      expect(deleted.history).toBeDisabled();
      expect(deleted.remove).toBeDisabled();
      expect(rowButtons(1).remove).toBeEnabled();
    });

    it('shows Deleted rather than Updated for a row that was updated then deleted', async () => {
      await renderApp();
      latestSocket().emitMessage({ type: 'rows_updated', ids: [1] });
      latestSocket().emitMessage({ type: 'rows_deleted', ids: [1] });

      expect(within(tableRow(1)).getByText('Deleted')).toBeInTheDocument();
      expect(within(tableRow(1)).queryByText('Updated')).not.toBeInTheDocument();
    });

    it('ignores ids that are not on the current page', async () => {
      await renderApp();
      latestSocket().emitMessage({ type: 'rows_updated', ids: [99] });
      latestSocket().emitMessage({ type: 'rows_deleted', ids: [98] });

      expect(screen.queryByText('Updated')).not.toBeInTheDocument();
      expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
      for (const id of [1, 2, 3]) expect(rowButtons(id).remove).toBeEnabled();
    });

    it('marks the open edit modal stale when its row is updated', async () => {
      const { user } = await renderApp();
      await user.click(rowButtons(2).edit);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('button', { name: 'OK' })).toBeEnabled();

      latestSocket().emitMessage({ type: 'rows_updated', ids: [2] });

      expect(
        within(dialog).getByText('This row has changed since you opened it. Saving will fail until you load the latest values.'),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'OK' })).toBeDisabled();
    });

    it('reconnects 3 seconds after the socket closes and forgets the client id', async () => {
      const { user } = await renderApp();
      const first = latestSocket();
      first.emitMessage({ type: 'connected', clientId: 'client-42' });

      const closedAt = Date.now();
      first.emitClose();
      expect(screen.getByText('Websocket: closed')).toBeInTheDocument();
      expect(FakeWebSocket.instances).toHaveLength(1);

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 5000 });
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(2900);
      expect(latestSocket().url).toBe(first.url);

      mockedDelete.mockResolvedValueOnce(ok({}));
      await user.click(rowButtons(1).remove);
      await user.click(await screen.findByRole('button', { name: 'OK' }));
      await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('/row/1', { headers: {} }));
    });

    it('closes the socket on unmount and does not reconnect', async () => {
      const { unmount } = await renderApp();
      const socket = latestSocket();

      unmount();
      expect(socket.close).toHaveBeenCalled();
      socket.onclose?.(new CloseEvent('close'));
      await new Promise((resolve) => setTimeout(resolve, 3300));
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });

  describe('deleting', () => {
    it('confirms, DELETEs the row and reloads the rows', async () => {
      const { user } = await renderApp();
      expect(rowCalls()).toHaveLength(1);
      mockedDelete.mockResolvedValueOnce(ok({}));
      serveRows(() => response(pageOneRows.slice(1), 2, 1));

      await user.click(rowButtons(1).remove);
      expect(await screen.findByText('Delete this row?')).toBeInTheDocument();
      expect(mockedDelete).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'OK' }));

      await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
      expect(mockedDelete).toHaveBeenCalledTimes(1);
      expect(mockedDelete.mock.calls[0][0]).toBe('/row/1');
      expect(rowCalls()).toHaveLength(2);
      expect(rowCalls()[1]).toEqual({ page: 1, limit: 100 });
      expect(await screen.findByText('Deleted')).toBeInTheDocument();
    });

    it('does not DELETE when the confirmation is cancelled', async () => {
      const { user } = await renderApp();

      await user.click(rowButtons(1).remove);
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(mockedDelete).not.toHaveBeenCalled();
      expect(rowCalls()).toHaveLength(1);
    });

    it('shows an error and keeps the rows when the DELETE fails', async () => {
      const { user } = await renderApp();
      mockedDelete.mockRejectedValueOnce(new Error('nope'));

      await user.click(rowButtons(1).remove);
      await user.click(await screen.findByRole('button', { name: 'OK' }));

      expect(await screen.findByText('Failed to delete row.')).toBeInTheDocument();
      expect(rowCalls()).toHaveLength(1);
    });
  });
});
