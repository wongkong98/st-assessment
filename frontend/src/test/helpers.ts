import { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import type { MessageInstance } from 'antd/es/message/interface';
import { vi } from 'vitest';
import type { CsvRow } from '../types/csvFile';

export const makeRow = (overrides: Partial<CsvRow> = {}): CsvRow => ({
  id: 1,
  post_id: 10,
  name: 'Alice',
  email: 'alice@example.com',
  body: 'Hello world',
  date_created: '2024-01-01T00:00:00.000Z',
  version: 1,
  ...overrides,
});

export const axiosError = (status: number, data: unknown = {}) => {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  const response = { status, statusText: String(status), data, headers: {}, config } as AxiosResponse;
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
};

export const ok = <T>(data: T) => ({ data }) as AxiosResponse<T>;

export const createMessageApi = () => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  open: vi.fn(),
  destroy: vi.fn(),
}) satisfies MessageInstance;

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
