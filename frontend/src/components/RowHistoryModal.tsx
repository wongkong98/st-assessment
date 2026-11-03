import { memo, useEffect, useMemo, useState } from 'react';
import { Modal, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import { isAxiosError } from 'axios';
import api from '../api/client';
import RowValuesList from './RowValuesList';
import type { RowValues } from './RowValuesList';
import type { CsvRow, RowHistory } from '../types/csvFile';

interface RowVersion {
  key: string;
  version: number;
  date_archived: string;
  values: RowValues;
  previous: RowValues | null;
}

const versionColumns: TableColumnsType<RowVersion> = [
  {
    title: 'Version',
    dataIndex: 'version',
    key: 'version',
    width: 100,
    align: 'center'
  },
  {
    title: 'Date',
    dataIndex: 'date_archived',
    key: 'date_archived',
    width: 200,
    align: 'center'
  },
  {
    title: 'Values',
    key: 'values',
    render: (_value, version) => <RowValuesList row={version.values} other={version.previous} highlight='success' />,
  },
];

interface RowHistoryModalProps {
  row: CsvRow;
  messageApi: MessageInstance;
  onClose: () => void;
  onRowLoaded: (row: CsvRow) => void;
  onRowDeleted: (id: number) => void;
}

function RowHistoryModal({ row, messageApi, onClose, onRowLoaded, onRowDeleted }: RowHistoryModalProps) {
  const [current, setCurrent] = useState(row);
  const [history, setHistory] = useState<RowHistory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    Promise.all([
      api.get<CsvRow>(`/row/${row.id}`),
      api.get<RowHistory[]>(`/row/${row.id}/history`),
    ])
      .then(([rowRes, historyRes]) => {
        if (ignore) return;
        setCurrent(rowRes.data);
        setHistory(historyRes.data);
        setLoading(false);
        onRowLoaded(rowRes.data);
      })
      .catch((err) => {
        if (ignore) return;
        if (isAxiosError(err) && err.response?.status === 404) {
          messageApi.error('This row has been deleted.');
          onRowDeleted(row.id);
        } else {
          messageApi.error('Failed to load row history.');
        }
        onClose();
      });

    return () => {
      ignore = true;
    };
  }, [row.id, messageApi, onClose, onRowLoaded, onRowDeleted]);

  const versions = useMemo<RowVersion[]>(() => {
    const all = [
      { 
        key: 'current',
        version: current.version,
        date_archived: '-',
        values: current
      },
      ...history.map((entry) => ({
        key: `history-${entry.id}`,
        version: entry.version,
        date_archived: new Date(entry.date_archived).toLocaleString(),
        values: entry,
      })),
    ];
    return all.map((version, i) => ({ ...version, previous: all[i + 1]?.values ?? null }));
  }, [current, history]);

  return (
    <Modal
      title={`History of row ${row.id}`}
      open
      width={800}
      onCancel={onClose}
      footer={null}
    >
      <Table
        rowKey='key'
        size='small'
        loading={loading}
        columns={versionColumns}
        dataSource={versions}
        scroll={{ y: 400 }}
        pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
      />
    </Modal>
  );
}

export default memo(RowHistoryModal);
