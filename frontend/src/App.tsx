import { useEffect, useState } from 'react'
import './App.css'
import { Button, Modal, Upload, message, Flex, Table, Form, Input } from 'antd';
import type { TableColumnsType, UploadFile } from 'antd';
import type { UploadChangeParam } from 'antd/es/upload';
import { DeleteFilled, EditFilled, InboxOutlined } from '@ant-design/icons';
import api from './api/client';
import type { CsvFile, FileListResponse } from './types/csvFile';

const { Dragger } = Upload;

interface AddFileFormValues {
  name: string;
  file?: UploadFile[];
}

function App() {
  const [addForm] = Form.useForm<AddFileFormValues>();

  const [showAddModal, setShowAddModal] = useState(false);
  const [files, setFiles] = useState<CsvFile[]>([]);
  const [loading, setLoading] = useState(true);

  const [page] = useState(1);
  const [limit] = useState(10);

  const [messageApi, contextHolder] = message.useMessage();

  const columns: TableColumnsType<CsvFile> = [
    {
      title: 'id',
      dataIndex: 'id',
      key: 'id',
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Path',
      dataIndex: 'path',
      key: 'path',
    },
    {
      title: 'Date Uploaded',
      dataIndex: 'date_uploaded',
      key: 'date_uploaded',
    },
    {
      key: "action",
      render: () => {
        return <Flex gap={10}>
          <Button icon={<EditFilled />} />
          <Button icon={<DeleteFilled style={{ color: 'red'}} />} />
        </Flex> 
      }
    }
  ];

  const retrieveFiles = () => {
    let ignore = false;

    api.get<FileListResponse>('/file', { params: { page, limit } })
      .then((res) => {
        if (!ignore) setFiles(res.data.data);
      })
      .catch(() => {
        if (!ignore) messageApi.error('Failed to load files.');
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
  }

  useEffect(() => {
    retrieveFiles();
  }, [page, limit]);

  const normFile = (e: UploadFile[] | UploadChangeParam<UploadFile>) => {
    if (Array.isArray(e)) {
      return e;
    }
    return e?.fileList;
  };

  const handleAddFile = async (values: AddFileFormValues) => {
    const formData = new FormData();
    
    formData.append('name', values.name);

    if (values.file && values.file.length > 0) {
      const file = values.file[0].originFileObj;
      if (file) {
        formData.append('file', file);
      }
    }

    try {
      const response = await api.post('/file', formData);
      
      if (response) {
        messageApi.success('Upload successful!');
        addForm.resetFields();
        setShowAddModal(false);
        await retrieveFiles();
      } else {
        messageApi.error('Upload failed.');
      }
    } catch {
      messageApi.error('An error occurred during upload.');
    }
  }

  return (
    <>
      {contextHolder}

      <div>
        <Button
          onClick={() => setShowAddModal(true)}
        >
          Add
        </Button>

        <Table
          rowKey='id'
          loading={loading}
          columns={columns}
          dataSource={files}
        />
      </div>

      <Modal
        title="Add New Data"
        open={showAddModal}
        onOk={() => addForm.submit()}
        onCancel={() => setShowAddModal(false)}
      >
        <Form form={addForm} onFinish={handleAddFile} layout='vertical'>
          <Form.Item
            label='Name'
            name='name'
            rules={[
              {
                required: true
              }
            ]}
          >
            <Input />
          </Form.Item>

          <Form.Item
            label='file'
            name='file'
            valuePropName='fileList'
            getValueFromEvent={normFile}
          >
            <Dragger
              listType="text"
              beforeUpload={() => false}
              maxCount={1}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">Click or drag file to this area to upload</p>
            </Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export default App
