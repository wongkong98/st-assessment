import { memo, useState } from 'react';
import { Alert, Button, Flex, Form, Input, Modal } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';
import { isAxiosError } from 'axios';
import api from '../api/client';
import type { CsvRow } from '../types/csvFile';

interface EditRowModalProps {
  row: CsvRow;
  stale: boolean;
  messageApi: MessageInstance;
  getHeaders: () => Record<string, string>;
  onClose: () => void;
  onRowLoaded: (row: CsvRow) => void;
  onRowDeleted: (id: number) => void;
}

function EditRowModal({ row, stale, messageApi, getHeaders, onClose, onRowLoaded, onRowDeleted }: EditRowModalProps) {
  const [form] = Form.useForm<CsvRow>();
  const [conflict, setConflict] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [newRow, setNewRow] = useState<CsvRow | null>(null);

  const handleDeleted = () => {
    messageApi.error('This row has been deleted.');
    onRowDeleted(row.id);
    onClose();
  };

  const handleSubmit = async (values: CsvRow) => {
    if (!isDirty) {
      onClose();
      return;
    }
    try {
      const { data } = await api.put<CsvRow>(`/row/${row.id}`, values, { headers: getHeaders() });
      onRowLoaded(data);
      messageApi.success("Updated");
      onClose();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setConflict(true);
      } else if (isAxiosError(err) && err.response?.status === 404) {
        handleDeleted();
      } else if (isAxiosError(err) && err.response?.status === 400) {
        messageApi.error(err.response.data?.error ?? 'Failed to update row.');
      } else {
        messageApi.error('Failed to update row.');
      }
    }
  };

  const replaceField = (field: 'name' | 'body' | 'email' | 'post_id') => {
    if (!newRow) return;
    form.setFieldValue(field, newRow[field]);
    setIsDirty(true);
  };

  const handleLoadLatest = async () => {
    try {
      const { data } = await api.get<CsvRow>(`/row/${row.id}`);
      form.setFieldValue('version', data.version);
      setNewRow(data);
      onRowLoaded(data);
      setConflict(false);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 404) {
        handleDeleted();
      } else {
        messageApi.error('Failed to load the latest values.');
      }
    }
  };

  return (
    <Modal
      title="Edit Row"
      open
      onOk={() => form.submit()}
      onCancel={onClose}
      okButtonProps={{
        disabled: conflict || stale
      }}
    >
      {(conflict || stale) && (
        <Alert
          style={{ marginBottom: 16 }}
          type={conflict ? 'error' : 'warning'}
          showIcon
          title={conflict
            ? 'Not saved: someone else changed this row while you were editing.'
            : 'This row has changed since you opened it. Saving will fail until you load the latest values.'}
          description='Load the latest values to see what changed. What you have typed is kept; use Replace to take any of the new values.'
          action={<Button size='small' onClick={handleLoadLatest}>Load latest values</Button>}
        />
      )}

      {
        newRow && <Alert
          showIcon
          style={{ marginBottom: 16 }}
          type={'warning'}
          title={'New Values'}
          description={
            <>
              <Flex justify='space-between' align='center' gap={10}>
                <p>Name: {newRow.name}</p>
                <Button onClick={() => replaceField('name')}>Replace</Button>
              </Flex>

              <Flex justify='space-between' align='center' gap={10}>
                <p>Body: {newRow.body}</p>
                <Button onClick={() => replaceField('body')}>Replace</Button>
              </Flex>
              
              <Flex justify='space-between' align='center' gap={10}>
                <p>Email: {newRow.email}</p>
                <Button onClick={() => replaceField('email')}>Replace</Button>
              </Flex>

              <Flex justify='space-between' align='center' gap={10}>
                <p>Post Id: {newRow.post_id}</p>
                <Button onClick={() => replaceField('post_id')}>Replace</Button>
              </Flex>
            </>
          }
        />
      }
      
      <Form
        style={{ width: "100%" }}
        form={form}
        onValuesChange={() => setIsDirty(true)}
        initialValues={row}
        onFinish={handleSubmit}
        layout='vertical'
      >
        <Form.Item name='id' label='id' hidden>
          <Input />
        </Form.Item>

        <Form.Item name='version' hidden>
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
  );
}

export default memo(EditRowModal);
