import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Button, message, Flex, Tag, Tooltip, Popconfirm, Badge } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import { DeleteFilled, EditFilled, FieldTimeOutlined } from '@ant-design/icons';
import api from './api/client';
import CsvImporter from './components/CsvImporter';
import EditRowModal from './components/EditRowModal';
import RowHistoryModal from './components/RowHistoryModal';
import RowsTable from './components/RowsTable';
import SearchBar from './components/SearchBar';
import type { CsvRow, RowFilters, RowResponse, SocketMessage } from './types/csvFile';

const RECONNECT_DELAY_MS = 3000;
const DEFAULT_PAGE_SIZE = 100;
const TABLE_SCROLL = { y: 400 };

function App() {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [filters, setFilters] = useState<RowFilters>({});
  const [websocketStatus, setWebsocketStatus] = useState("attempting");

  const [editingRow, setEditingRow] = useState<CsvRow | null>(null);
  const [historyRow, setHistoryRow] = useState<CsvRow | null>(null);

  const [messageApi, contextHolder] = message.useMessage();

  const clientIdRef = useRef<string | null>(null);
  const clientHeaders = useCallback(
    (): Record<string, string> => (clientIdRef.current ? { 'X-Client-Id': clientIdRef.current } : {}),
    []
  );

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
        setWebsocketStatus('connected');
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
        setWebsocketStatus('closed');
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

  const reloadRows = useCallback(() => {
    setLoading(true);
    setReloadKey((key) => key + 1);
  }, []);

  const replaceRow = useCallback((updated: CsvRow) => {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
  }, []);

  const markRowDeleted = useCallback((id: number) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, is_deleted: true } : row)));
  }, []);

  const handleSearch = useCallback((nextFilters: RowFilters) => {
    setLoading(true);
    setPage(1);
    setFilters(nextFilters);
  }, []);

  const handleTableChange = useCallback((pagination: TablePaginationConfig) => {
    setLoading(true);
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? DEFAULT_PAGE_SIZE);
  }, []);

  const closeEditModal = useCallback(() => setEditingRow(null), []);
  const closeHistoryModal = useCallback(() => setHistoryRow(null), []);

  const handleDelete = useCallback(async (record: CsvRow) => {
    try {
      await api.delete(`/row/${record.id}`, { headers: clientHeaders() });
      messageApi.success('Deleted');
      reloadRows();
    } catch {
      messageApi.error('Failed to delete row.');
    }
  }, [clientHeaders, messageApi, reloadRows]);

  const columns = useMemo<TableColumnsType<CsvRow>>(() => [
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
          <Button onClick={() => setEditingRow(record)} icon={<EditFilled />} disabled={record.is_deleted} />

          <Badge dot={record.is_stale}>
            <Button onClick={() => setHistoryRow(record)} icon={<FieldTimeOutlined />} disabled={record.is_deleted} />
          </Badge>

          <Popconfirm title='Delete this row?' onConfirm={() => handleDelete(record)} disabled={record.is_deleted}>
            <Button icon={<DeleteFilled style={{ color: 'red'}} />} disabled={record.is_deleted} />
          </Popconfirm>
        </Flex>
      }
    }
  ], [handleDelete]);

  const pagination = useMemo<TablePaginationConfig>(() => ({
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 50, 100],
  }), [page, pageSize, total]);

  const editingStale = editingRow !== null && rows.some((row) => row.id === editingRow.id && row.is_stale);

  return (
    <>
      {contextHolder}

      <div>
        <Flex gap={20} align='center' style={{ marginBottom: 10 }}>
          <CsvImporter messageApi={messageApi} onImported={reloadRows} />

          <p style={{ margin: 0 }}>Websocket: {websocketStatus}</p>
        </Flex>

        <SearchBar onSearch={handleSearch} />

        {historyRow && (
          <RowHistoryModal
            key={historyRow.id}
            row={historyRow}
            messageApi={messageApi}
            onClose={closeHistoryModal}
            onRowLoaded={replaceRow}
            onRowDeleted={markRowDeleted}
          />
        )}

        {editingRow && (
          <EditRowModal
            key={editingRow.id}
            row={editingRow}
            stale={editingStale}
            messageApi={messageApi}
            getHeaders={clientHeaders}
            onClose={closeEditModal}
            onRowLoaded={replaceRow}
            onRowDeleted={markRowDeleted}
          />
        )}

        <RowsTable
          rowKey='id'
          virtual
          loading={loading}
          columns={columns}
          dataSource={rows}
          onChange={handleTableChange}
          scroll={TABLE_SCROLL}
          pagination={pagination}
        />
      </div>
    </>
  )
}

export default App
