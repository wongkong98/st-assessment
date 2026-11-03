import { memo, useEffect, useRef, useState } from 'react';
import { Button, Empty, Flex, Modal, Progress, Table, Tag, Typography, Upload } from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import { UploadOutlined } from '@ant-design/icons';
import api from '../api/client';
import RowValuesList from './RowValuesList';
import type { ChangedRow, ImportJob } from '../types/csvFile';

const POLL_INTERVAL_MS = 500;

const changeTag = (change: ChangedRow) => {
  if (!change.old) return <Tag color='green'>New</Tag>;
  if (!change.new) return <Tag color='red'>Deleted</Tag>;
  return <Tag color='orange'>Updated</Tag>;
};

const makeChangeColumns = (oldTitle: string, newTitle: string): TableColumnsType<ChangedRow> => [
  {
    title: 'Id',
    dataIndex: 'id',
    key: 'id',
    width: 90,
    render: (id: number, change) => (
      <Flex vertical gap={4} align='start'>
        {id}
        {changeTag(change)}
      </Flex>
    ),
  },
  {
    title: oldTitle,
    key: 'old',
    render: (_value, change) => <RowValuesList row={change.old} other={change.new} highlight='danger' />,
  },
  {
    title: newTitle,
    key: 'new',
    render: (_value, change) => <RowValuesList row={change.new} other={change.old} highlight='success' />,
  },
];

const importColumns = makeChangeColumns('Old', 'New');
const staleColumns = makeChangeColumns('When you uploaded', 'Now');

interface CsvImporterProps {
  messageApi: MessageInstance;
  onImported: () => void;
}

function CsvImporter({ messageApi, onImported }: CsvImporterProps) {
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [showImportResult, setShowImportResult] = useState(false);
  const fileRef = useRef<Blob | null>(null);

  const running = importJob?.status === 'processing' || importJob?.status === 'waiting';
  const pollingId = running ? importJob.id : null;

  useEffect(() => {
    if (!pollingId) return;

    let cancelled = false;
    let timer: number;

    const poll = async () => {
      try {
        const { data } = await api.get<ImportJob>(`/file/${pollingId}`);
        if (cancelled) return;
        setImportJob(data);

        if (data.status === 'processing' || data.status === 'waiting') {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        } else if (data.status === 'completed') {
          messageApi.success(`Imported ${data.processed_rows} rows from ${data.name}.`);
          setShowImportResult(true);
          onImported();
        } else if (data.status === 'stale') {
          messageApi.warning(`${data.name} was not imported because some of its rows changed.`);
          setShowImportResult(true);
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
  }, [pollingId, messageApi, onImported]);

  const startUpload = async (file: Blob, force: boolean) => {
    const formData = new FormData();
    formData.append('file', file);
    if (force) formData.append('force', 'true');

    fileRef.current = file;
    setShowImportResult(false);
    setUploadPercent(0);
    try {
      const { data } = await api.post<ImportJob>('/file', formData, {
        onUploadProgress: (e) => {
          if (e.total) setUploadPercent(Math.round((e.loaded / e.total) * 100));
        },
      });
      setImportJob(data);
      return data;
    } finally {
      setUploadPercent(null);
    }
  };

  const handleUpload: UploadProps['customRequest'] = async ({ file, onSuccess, onError }) => {
    try {
      onSuccess?.(await startUpload(file as Blob, false));
    } catch (err) {
      messageApi.error('Upload failed.');
      onError?.(err as Error);
    }
  };

  const handleImportAnyway = async () => {
    if (!fileRef.current) return;
    try {
      await startUpload(fileRef.current, true);
    } catch {
      messageApi.error('Upload failed.');
    }
  };

  const closeResult = () => setShowImportResult(false);

  const busy = uploadPercent !== null || running;
  const stale = !busy && importJob?.status === 'stale';

  let progressLabel = '';
  let progressPercent = 0;
  if (uploadPercent !== null) {
    progressLabel = 'Uploading file...';
    progressPercent = uploadPercent;
  } else if (importJob?.status === 'waiting') {
    progressLabel = 'Waiting for another import to finish...';
  } else if (running && importJob.total_rows === null) {
    progressLabel = 'Reading file...';
  } else if (running) {
    progressLabel = `Importing rows: ${importJob.processed_rows} / ${importJob.total_rows}`;
    progressPercent = importJob.total_rows
      ? Math.round((importJob.processed_rows / importJob.total_rows) * 100)
      : 100;
  }

  let content;
  if (busy) {
    content = (
      <div>
        {progressLabel}
        <Progress percent={progressPercent} status='active' />
      </div>
    );
  } else if (stale && importJob.concurrent_changes) {
    content = (
      <>
        <Typography.Paragraph>
          While your upload was waiting, someone else changed {importJob.concurrent_changes.length} of the rows
          in {importJob.name}. Nothing from your file was imported. Importing anyway will overwrite these changes.
        </Typography.Paragraph>
        <Table
          rowKey='id'
          size='small'
          columns={staleColumns}
          dataSource={importJob.concurrent_changes}
          scroll={{ y: 400 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </>
    );
  } else if (importJob?.changed_rows?.length) {
    content = (
      <>
        <Typography.Paragraph>
          {importJob.changed_rows.length} of {importJob.processed_rows} rows in {importJob.name} were new or changed.
        </Typography.Paragraph>
        <Table
          rowKey='id'
          size='small'
          columns={importColumns}
          dataSource={importJob.changed_rows}
          scroll={{ y: 400 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </>
    );
  } else {
    content = <Empty description={`No rows were changed by importing ${importJob?.name ?? 'the file'}.`} />;
  }

  return (
    <>
      <Upload
        showUploadList={false}
        accept='.csv'
        customRequest={handleUpload}
        disabled={busy}
      >
        <Button icon={<UploadOutlined />} loading={busy}>
          Upload
        </Button>
      </Upload>

      <Modal
        title={stale ? 'Rows changed since you uploaded' : 'Importing the CSV file'}
        open={busy || showImportResult}
        width={busy ? undefined : 1000}
        closable={!busy}
        mask={{ closable: false }}
        onCancel={closeResult}
        footer={busy ? null : stale ? (
          <Flex gap={8} justify='end'>
            <Button onClick={closeResult}>Cancel</Button>
            <Button type='primary' danger onClick={handleImportAnyway}>Import anyway</Button>
          </Flex>
        ) : (
          null
        )}
      >
        {content}
      </Modal>
    </>
  );
}

export default memo(CsvImporter);
