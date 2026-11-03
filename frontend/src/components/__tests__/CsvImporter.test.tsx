import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AxiosProgressEvent, AxiosRequestConfig, AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api/client';
import type { ChangedRow, ImportJob } from '../../types/csvFile';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { createMessageApi, deferred, makeRow, ok } from '../../test/helpers';
import CsvImporter from '../CsvImporter';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const POLL_WAIT = { timeout: 3000 };

const job = (overrides: Partial<ImportJob> = {}): ImportJob => ({
  id: 'job-1',
  name: 'data.csv',
  status: 'processing',
  total_rows: null,
  processed_rows: 0,
  error: null,
  ...overrides,
});

const changedRows: ChangedRow[] = [
  { id: 1, old: null, new: makeRow({ id: 1, name: 'Fresh' }) },
  { id: 2, old: makeRow({ id: 2, name: 'Before' }), new: makeRow({ id: 2, name: 'After' }) },
];

const NoMotion = ({ children }: { children: ReactNode }) => (
  <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
);

const setup = () => {
  const messageApi = createMessageApi();
  const onImported = vi.fn();
  const user = userEvent.setup();
  const view = render(<CsvImporter messageApi={messageApi} onImported={onImported} />, { wrapper: NoMotion });
  const file = new File(['id,name\n1,Fresh\n'], 'data.csv', { type: 'text/csv' });
  const fileInput = () => view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const upload = () => user.upload(fileInput(), file);
  return { messageApi, onImported, user, file, fileInput, upload, ...view };
};

const postedForm = (call = 0) => mockedPost.mock.calls[call][1] as FormData;

const resultRows = () =>
  Array.from(screen.getByRole('dialog').querySelectorAll<HTMLTableRowElement>('tr[data-row-key]'));

const pollSequence = (...jobs: ImportJob[]) => {
  for (const next of jobs) mockedGet.mockResolvedValueOnce(ok(next));
};

describe('CsvImporter', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPost.mockReset();
  });

  it('POSTs the chosen file as multipart form data with the file field', async () => {
    mockedPost.mockResolvedValueOnce(ok(job({ status: 'completed', changed_rows: [] })));
    const ctx = setup();
    await ctx.upload();

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));
    const [url, body, config] = mockedPost.mock.calls[0];
    expect(url).toBe('/file');
    expect(body).toBeInstanceOf(FormData);
    const sent = (body as FormData).get('file') as File;
    expect(sent).toBeInstanceOf(File);
    expect(sent.name).toBe('data.csv');
    expect((body as FormData).has('force')).toBe(false);
    expect(config).toEqual(expect.objectContaining({ onUploadProgress: expect.any(Function) }));
  });

  it('shows upload progress while the file is uploading', async () => {
    const pending = deferred<AxiosResponse<ImportJob>>();
    let reportProgress: (e: AxiosProgressEvent) => void = () => {};
    mockedPost.mockImplementationOnce(((_url: string, _data: unknown, config: AxiosRequestConfig) => {
      reportProgress = config.onUploadProgress!;
      return pending.promise;
    }) as typeof api.post);
    const ctx = setup();
    await ctx.upload();

    expect(await screen.findByText('Uploading file...')).toBeInTheDocument();
    expect(screen.getByText('Importing the CSV file')).toBeInTheDocument();
    act(() => reportProgress({ loaded: 40, total: 100, bytes: 40, lengthComputable: true }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');

    await act(async () => pending.resolve(ok(job())));
    expect(await screen.findByText('Reading file...')).toBeInTheDocument();
  });

  it('disables the Upload button while busy', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    mockedGet.mockReturnValue(new Promise(() => {}));
    const ctx = setup();
    const uploadButton = screen.getByRole('button', { name: /upload/i });
    expect(ctx.fileInput()).toBeEnabled();

    await ctx.upload();
    await screen.findByText('Reading file...');

    expect(ctx.fileInput()).toBeDisabled();
    expect(uploadButton).toHaveClass('ant-btn-loading');
    expect(ctx.container.querySelector('.ant-upload-disabled')).not.toBeNull();
  });

  it('polls GET /file/:id and shows reading, importing and waiting progress labels', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(
      job({ total_rows: 10, processed_rows: 4 }),
      job({ status: 'waiting' }),
      job({ status: 'completed', total_rows: 10, processed_rows: 10, changed_rows: [] }),
    );
    const ctx = setup();
    await ctx.upload();

    expect(await screen.findByText('Reading file...')).toBeInTheDocument();
    expect(await screen.findByText('Importing rows: 4 / 10', {}, POLL_WAIT)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(await screen.findByText('Waiting for another import to finish...', {}, POLL_WAIT)).toBeInTheDocument();
    await waitFor(() => expect(ctx.onImported).toHaveBeenCalledTimes(1), POLL_WAIT);

    expect(mockedGet).toHaveBeenCalledTimes(3);
    for (const call of mockedGet.mock.calls) expect(call[0]).toBe('/file/job-1');
  });

  it('shows the changed rows and calls onImported when the import completes', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(job({ status: 'completed', total_rows: 10, processed_rows: 10, changed_rows: changedRows }));
    const ctx = setup();
    await ctx.upload();

    await waitFor(() => expect(ctx.onImported).toHaveBeenCalledTimes(1), POLL_WAIT);
    expect(ctx.messageApi.success).toHaveBeenCalledWith('Imported 10 rows from data.csv.');
    expect(screen.getByText('2 of 10 rows in data.csv were new or changed.')).toBeInTheDocument();

    const [created, updated] = resultRows();
    expect(within(created).getByText('New')).toBeInTheDocument();
    expect(within(created).getByText('Fresh')).toBeInTheDocument();
    expect(within(created).getByText('—')).toBeInTheDocument();
    expect(within(updated).getByText('Updated')).toBeInTheDocument();
    expect(within(updated).getByText('Before').closest('.ant-typography')).toHaveClass('ant-typography-danger');
    expect(within(updated).getByText('After').closest('.ant-typography')).toHaveClass('ant-typography-success');
    expect(ctx.fileInput()).toBeEnabled();
  });

  it('shows an empty state when the completed import changed no rows', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(job({ status: 'completed', total_rows: 3, processed_rows: 3, changed_rows: [] }));
    const ctx = setup();
    await ctx.upload();

    expect(await screen.findByText('No rows were changed by importing data.csv.', {}, POLL_WAIT)).toBeInTheDocument();
    expect(ctx.onImported).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation when the import is stale and does not call onImported', async () => {
    const concurrent: ChangedRow[] = [
      { id: 3, old: makeRow({ id: 3, name: 'Mine' }), new: makeRow({ id: 3, name: 'Theirs' }) },
      { id: 4, old: makeRow({ id: 4, name: 'Gone' }), new: null },
    ];
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(job({ status: 'stale', total_rows: 5, processed_rows: 0, concurrent_changes: concurrent }));
    const ctx = setup();
    await ctx.upload();

    expect(await screen.findByText('Rows changed since you uploaded', {}, POLL_WAIT)).toBeInTheDocument();
    expect(ctx.messageApi.warning).toHaveBeenCalledWith(
      'data.csv was not imported because some of its rows changed.',
    );
    expect(ctx.onImported).not.toHaveBeenCalled();

    const [updated, deleted] = resultRows();
    expect(within(updated).getByText('Updated')).toBeInTheDocument();
    expect(within(updated).getByText('Theirs')).toBeInTheDocument();
    expect(within(deleted).getByText('Deleted')).toBeInTheDocument();
    expect(within(deleted).getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import anyway' })).toBeInTheDocument();
  });

  it('closes the stale dialog on Cancel without uploading again', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(job({ status: 'stale', concurrent_changes: changedRows }));
    const ctx = setup();
    await ctx.upload();
    await screen.findByText('Rows changed since you uploaded', {}, POLL_WAIT);

    await ctx.user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('re-uploads the same file with force=true on Import anyway', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(
      job({ status: 'stale', concurrent_changes: changedRows }),
      job({ id: 'job-2', status: 'completed', total_rows: 2, processed_rows: 2, changed_rows: [] }),
    );
    const ctx = setup();
    await ctx.upload();
    await screen.findByText('Rows changed since you uploaded', {}, POLL_WAIT);

    mockedPost.mockResolvedValueOnce(ok(job({ id: 'job-2' })));
    await ctx.user.click(screen.getByRole('button', { name: 'Import anyway' }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2));
    expect(mockedPost.mock.calls[1][0]).toBe('/file');
    expect(postedForm(1).get('file')).toBe(postedForm(0).get('file'));
    expect(postedForm(1).get('force')).toBe('true');

    await waitFor(() => expect(ctx.onImported).toHaveBeenCalledTimes(1), POLL_WAIT);
    expect(mockedGet).toHaveBeenLastCalledWith('/file/job-2');
  });

  it('shows the job error when the import fails', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    pollSequence(job({ status: 'failed', error: 'Bad header row' }));
    const ctx = setup();
    await ctx.upload();

    await waitFor(() => expect(ctx.messageApi.error).toHaveBeenCalledWith('Import failed: Bad header row'), POLL_WAIT);
    expect(ctx.onImported).not.toHaveBeenCalled();
  });

  it('reports a lost import and stops polling when a poll request throws', async () => {
    mockedPost.mockResolvedValueOnce(ok(job()));
    mockedGet.mockRejectedValueOnce(new Error('network down'));
    mockedGet.mockResolvedValue(ok(job()));
    const ctx = setup();
    await ctx.upload();

    await waitFor(() => expect(ctx.messageApi.error).toHaveBeenCalledWith('Lost track of the import.'), POLL_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(ctx.fileInput()).toBeEnabled();
  });

  it('shows an error when the upload request fails', async () => {
    mockedPost.mockRejectedValueOnce(new Error('offline'));
    const ctx = setup();
    await ctx.upload();

    await waitFor(() => expect(ctx.messageApi.error).toHaveBeenCalledWith('Upload failed.'));
    expect(mockedGet).not.toHaveBeenCalled();
    expect(ctx.fileInput()).toBeEnabled();
  });
});
