import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Button, Upload, message, Flex, Table, Progress, Modal, Input, DatePicker, Tag, Tooltip, Form, Popconfirm, Typography, Empty, Badge } from 'antd';
import type { GetProps, TableColumnsType, TablePaginationConfig, UploadProps } from 'antd';
import { DeleteFilled, EditFilled, FieldTimeOutlined, UploadOutlined } from '@ant-design/icons';
import api from './api/client';
import { isAxiosError } from 'axios';
import type { ChangedRow, CsvRow, ImportJob, RowHistory, RowResponse, SocketMessage } from './types/csvFile';

const POLL_INTERVAL_MS = 500;
const RECONNECT_DELAY_MS = 3000;
const DEFAULT_PAGE_SIZE = 100;

type DateRange = GetProps<typeof DatePicker.RangePicker>['value'];

interface RowFilters {
  search?: string;
  from?: string;
  to?: string;
}

const DIFF_FIELDS = ['post_id', 'name', 'email', 'body'] as const;

type RowValues = Pick<CsvRow, typeof DIFF_FIELDS[number]>;

interface RowVersion {
  key: string;
  label: string;
  values: RowValues;
  previous: RowValues | null;
}

const renderRowValues = (row: RowValues | null, other: RowValues | null, highlight: 'danger' | 'success') => {
  if (!row) return <Typography.Text type='secondary'>—</Typography.Text>;

  return (
    <Flex vertical gap={2}>
      {DIFF_FIELDS.map((field) => {
        const changed = other !== null && row[field] !== other[field];
        return (
          <div key={field}>
            <Typography.Text type='secondary'>{field}: </Typography.Text>
            <Typography.Text type={changed ? highlight : undefined} strong={changed}>
              {row[field]}
            </Typography.Text>
          </div>
        );
      })}
    </Flex>
  );
};

const changeColumns: TableColumnsType<ChangedRow> = [
  {
    title: 'Id',
    dataIndex: 'id',
    key: 'id',
    width: 90,
    render: (id: number, change) => (
      <Flex vertical gap={4} align='start'>
        {id}
        {change.old ? <Tag color='orange'>Updated</Tag> : <Tag color='green'>New</Tag>}
      </Flex>
    ),
  },
  {
    title: 'Old',
    key: 'old',
    render: (_value, change) => renderRowValues(change.old, change.new, 'danger'),
  },
  {
    title: 'New',
    key: 'new',
    render: (_value, change) => renderRowValues(change.new, change.old, 'success'),
  },
];

const versionColumns: TableColumnsType<RowVersion> = [
  {
    title: 'Version',
    dataIndex: 'label',
    key: 'label',
    width: 200,
  },
  {
    title: 'Values',
    key: 'values',
    render: (_value, version) => renderRowValues(version.values, version.previous, 'success'),
  },
];

function App() {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [showEditModal, setShowEditModal] = useState(false);

  const [editForm] = Form.useForm();

  const [searchText, setSearchText] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [filters, setFilters] = useState<RowFilters>({});

  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [showImportResult, setShowImportResult] = useState(false);

  const [historyRow, setHistoryRow] = useState<CsvRow | null>(null);
  const [history, setHistory] = useState<RowHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequestRef = useRef<number | null>(null);

  const [messageApi, contextHolder] = message.useMessage();

  const clientIdRef = useRef<string | null>(null);
  const clientHeaders = () => (clientIdRef.current ? { 'X-Client-Id': clientIdRef.current } : {});

  const columns: TableColumnsType<CsvRow> = [
    {
      title: 'Id',
      dataIndex: 'id',
      key: 'id',
      render: (id: number, row) => (
        <Flex gap={6} align='center'>
          {id}
          {row.is_deleted ? (
            <Tooltip title='This row has been deleted.'>
              <Tag color='red'>Deleted</Tag>
            </Tooltip>
          ) : row.is_stale && (
            <Tooltip title='This row has changed since it was loaded. Reload to see the latest.'>
              <Tag color='orange'>Updated</Tag>
            </Tooltip>
          )}
        </Flex>
      ),
    },
    {
      title: 'Post Id',
      dataIndex: 'post_id',
      key: 'post_id',
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Body',
      dataIndex: 'body',
      key: 'body',
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: 'Date Created',
      dataIndex: 'date_created',
      key: 'date_created',
      hidden: true
    },
    {
      key: "action",
      render: (_value, record) => {
        return <Flex gap={10}>
          <Button onClick={() => handleEditClick(record)} icon={<EditFilled />} disabled={record.is_deleted} />

          <Badge dot={record.is_stale}>
            <Button onClick={() => handleHistoryClick(record)} icon={<FieldTimeOutlined />} disabled={record.is_deleted} />
          </Badge>
          
          <Popconfirm title='Delete this row?' onConfirm={() => handleDelete(record)} disabled={record.is_deleted}>
            <Button icon={<DeleteFilled style={{ color: 'red'}} />} disabled={record.is_deleted} />
          </Popconfirm>
        </Flex>
      }
    }
  ];

  useEffect(() => {
    let ignore = false;

    api.get<RowResponse>('/row', { params: { page, limit: pageSize, ...filters } })
      .then((res) => {
        if (ignore) return;
        const { metadata, data } = res.data;
        if (data.length === 0 && page > 1 && page > metadata.totalPages) {
          setPage(Math.max(metadata.totalPages, 1));
          return;
        }
        setRows(data);
        setTotal(metadata.totalItems);
      })
      .catch(() => {
        if (!ignore) messageApi.error('Failed to load rows.');
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [page, pageSize, filters, reloadKey, messageApi]);

  useEffect(() => {
    let socket: WebSocket;
    let reconnectTimer: number;
    let closed = false;

    const connect = () => {
      const url = new URL(`${api.defaults.baseURL}/ws`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);

      socket.onmessage = (event) => {
        const message: SocketMessage = JSON.parse(event.data);
        if (message.type === 'connected') {
          clientIdRef.current = message.clientId;
          return;
        }

        const ids = new Set(message.ids);
        const flag = message.type === 'rows_deleted' ? { is_deleted: true } : { is_stale: true };
        setRows((current) =>
          current.some((row) => ids.has(row.id))
            ? current.map((row) => (ids.has(row.id) ? { ...row, ...flag } : row))
            : current
        );
      };

      socket.onclose = () => {
        clientIdRef.current = null;
        if (!closed) reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      socket.close();
    };
  }, []);

  const pollingId = importJob?.status === 'processing' ? importJob.id : null;

  useEffect(() => {
    if (!pollingId) return;

    let cancelled = false;
    let timer: number;

    const poll = async () => {
      try {
        const { data } = await api.get<ImportJob>(`/file/${pollingId}`);
        if (cancelled) return;
        setImportJob(data);

        if (data.status === 'processing') {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        } else if (data.status === 'completed') {
          messageApi.success(`Imported ${data.processed_rows} rows from ${data.name}.`);
          setShowImportResult(true);
          setLoading(true);
          setReloadKey((key) => key + 1);
        } else {
          messageApi.error(`Import failed: ${data.error}`);
        }
      } catch {
        if (cancelled) return;
        messageApi.error('Lost track of the import.');
        setImportJob(null);
      }
    };

    timer = window.setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pollingId, messageApi]);

  const handleUpload: UploadProps['customRequest'] = async ({ file, onSuccess, onError }) => {
    const formData = new FormData();
    formData.append('file', file);

    setUploadPercent(0);
    try {
      const { data } = await api.post<ImportJob>('/file', formData, {
        onUploadProgress: (e) => {
          if (e.total) setUploadPercent(Math.round((e.loaded / e.total) * 100));
        },
      });
      setImportJob(data);
      onSuccess?.(data);
    } catch (err) {
      messageApi.error('Upload failed.');
      onError?.(err as Error);
    } finally {
      setUploadPercent(null);
    }
  };

  const handleSearch = () => {
    setLoading(true);
    setPage(1);
    setFilters({
      search: searchText.trim() || undefined,
      from: dateRange?.[0]?.startOf('day').toISOString(),
      to: dateRange?.[1]?.endOf('day').toISOString(),
    });
  };

  const handleTableChange = (pagination: TablePaginationConfig) => {
    setLoading(true);
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? DEFAULT_PAGE_SIZE);
  };

  const importing = importJob?.status === 'processing';
  const busy = uploadPercent !== null || importing;

  let progressLabel = '';
  let progressPercent = 0;
  if (uploadPercent !== null) {
    progressLabel = 'Uploading file...';
    progressPercent = uploadPercent;
  } else if (importing && importJob.total_rows === null) {
    progressLabel = 'Reading file...';
  } else if (importing) {
    progressLabel = `Importing rows: ${importJob.processed_rows} / ${importJob.total_rows}`;
    progressPercent = importJob.total_rows
      ? Math.round((importJob.processed_rows / importJob.total_rows) * 100)
      : 100;
  }

  const handleEditClick = (record: CsvRow) => {
    setShowEditModal(true);

    editForm.setFieldsValue(record);
  };

  const handleEditSubmit = async (values: CsvRow) => {
    try {
      const { data } = await api.put<CsvRow>(`/row/${values.id}`, values, { headers: clientHeaders() });
      setRows((current) => current.map((row) => (row.id === data.id ? data : row)));
      messageApi.success("Updated");
      editForm.resetFields();
      setShowEditModal(false);
    } catch {
      messageApi.error('Failed to update row.');
    }
  };

  const handleHistoryClick = async (record: CsvRow) => {
    historyRequestRef.current = record.id;
    setHistoryRow(record);
    setHistory([]);
    setHistoryLoading(true);

    try {
      const [rowRes, historyRes] = await Promise.all([
        api.get<CsvRow>(`/row/${record.id}`),
        api.get<RowHistory[]>(`/row/${record.id}/history`),
      ]);
      if (historyRequestRef.current !== record.id) return;

      setHistoryRow(rowRes.data);
      setHistory(historyRes.data);
      setRows((current) => current.map((row) => (row.id === rowRes.data.id ? rowRes.data : row)));
    } catch (err) {
      if (historyRequestRef.current !== record.id) return;

      if (isAxiosError(err) && err.response?.status === 404) {
        messageApi.error('This row has been deleted.');
        setRows((current) => current.map((row) => (row.id === record.id ? { ...row, is_deleted: true } : row)));
      } else {
        messageApi.error('Failed to load row history.');
      }
      closeHistory();
    } finally {
      if (historyRequestRef.current === record.id) setHistoryLoading(false);
    }
  };

  const closeHistory = () => {
    historyRequestRef.current = null;
    setHistoryRow(null);
  };

  const historyVersions: RowVersion[] = historyRow
    ? [
        { key: 'current', label: 'Current', values: historyRow },
        ...history.map((entry) => ({
          key: `history-${entry.id}`,
          label: `Replaced ${new Date(entry.date_archived).toLocaleString()}`,
          values: entry,
        })),
      ].map((version, i, all) => ({ ...version, previous: all[i + 1]?.values ?? null }))
    : [];

  const handleDelete = async (record: CsvRow) => {
    try {
      await api.delete(`/row/${record.id}`, { headers: clientHeaders() });
      messageApi.success('Deleted');
      setLoading(true);
      setReloadKey((key) => key + 1);
    } catch {
      messageApi.error('Failed to delete row.');
    }
  };

  return (
    <>
      {contextHolder}

      <div>
        <Upload
          style={{ marginBottom: 10 }}
          showUploadList={false}
          accept='.csv'
          customRequest={handleUpload}
          disabled={busy}
        >
          <Button icon={<UploadOutlined />} loading={busy}>
            Upload
          </Button>
        </Upload>

        <Flex gap={10} style={{ marginBottom: 10 }}>
          <Input
            placeholder='Search By Name, Body or Email'
            allowClear
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onPressEnter={handleSearch}
          />

          <DatePicker.RangePicker
            allowEmpty={[true, true]}
            value={dateRange}
            onChange={setDateRange}
          />

          <Button type='primary' onClick={handleSearch}>
            Search
          </Button>
        </Flex>

        <Modal
          title="Importing the CSV file"
          open={busy || showImportResult}
          width={busy ? undefined : 1000}
          closable={!busy}
          mask={{ closable: false }}
          onCancel={() => setShowImportResult(false)}
          footer={busy ? null : <Button type='primary' onClick={() => setShowImportResult(false)}>Close</Button>}
        >
          {busy ? (
            <div>
              {progressLabel}
              <Progress percent={progressPercent} status='active' />
            </div>
          ) : importJob?.changed_rows?.length ? (
            <>
              <Typography.Paragraph>
                {importJob.changed_rows.length} of {importJob.processed_rows} rows in {importJob.name} were new or changed.
              </Typography.Paragraph>
              <Table
                rowKey='id'
                size='small'
                columns={changeColumns}
                dataSource={importJob.changed_rows}
                scroll={{ y: 400 }}
                pagination={{ pageSize: 10, showSizeChanger: false }}
              />
            </>
          ) : (
            <Empty description={`No rows were changed by importing ${importJob?.name ?? 'the file'}.`} />
          )}
        </Modal>

        <Modal
          title={`History of row ${historyRow?.id ?? ''}`}
          open={historyRow !== null}
          width={800}
          onCancel={closeHistory}
          footer={<Button type='primary' onClick={closeHistory}>Close</Button>}
        >
          <Table
            rowKey='key'
            size='small'
            loading={historyLoading}
            columns={versionColumns}
            dataSource={historyVersions}
            scroll={{ y: 400 }}
            pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          />
        </Modal>

        <Modal
          title="Edit Row"
          open={showEditModal}
          onOk={() => editForm.submit()}
          onCancel={() => setShowEditModal(false)}
        >
          <Form form={editForm} onFinish={handleEditSubmit} layout='vertical'>
            <Form.Item name='id' label='id' hidden>
              <Input />
            </Form.Item>

            <Form.Item name='name' label='Name'>
              <Input />
            </Form.Item>

            <Form.Item name='body' label='Body'>
              <Input.TextArea style={{ height: 100 }} />
            </Form.Item>

            <Form.Item name='email' label='Email'>
              <Input type='email' />
            </Form.Item>

            <Form.Item name='post_id' label='Post Id'>
              <Input type='number' min={0} />
            </Form.Item>
          </Form>
        </Modal>

        <Table
          rowKey='id'
          loading={loading}
          columns={columns}
          dataSource={rows}
          onChange={handleTableChange}
          scroll={{
            y: 400
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
          }}
        />
      </div>
    </>
  )
}

export default App
