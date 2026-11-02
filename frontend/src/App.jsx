import { useState } from 'react'
import './App.css'
import { Button, Modal, Upload, message, Flex, Table, Form, Input } from 'antd';
import { DeleteFilled, EditFilled, InboxOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import axios from 'axios';

const { Dragger } = Upload;

function App() {
  const [addForm] = Form.useForm();

  const [showAddModal, setShowAddModal] = useState(false);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [messageApi, contextHolder] = message.useMessage();

  const columns = [
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
      render: (_text, _record) => {
        return <Flex gap={10}>
          <Button icon={<EditFilled />} />
          <Button icon={<DeleteFilled style={{ color: 'red'}} />} />
        </Flex> 
      }
    }
  ];

  useEffect(() => {
    retrieveFiles();
  }, []);

  const retrieveFiles = async () => {
    setLoading(true);
    const res = await axios.get(`http://localhost:5000/api/file?page=${page}&limit=${limit}`);
    setFiles(res.data);
    setLoading(false);
  };

  const normFile = (e) => {
    if (Array.isArray(e)) {
      return e;
    }
    return e?.fileList;
  };

  const handleAddFile = async (values) => {
    const formData = new FormData();
    
    formData.append('name', values.name);

    if (values.file && values.file.length > 0) {
      const file = values.file[0].originFileObj;
      formData.append('file', file);
    }

    try {
      const response = await axios.post('http://localhost:5000/api/file', formData);
      
      if (response) {
        message.success('Upload successful!');
        addForm.resetFields();
      } else {
        message.error('Upload failed.');
      }
    } catch (error) {
      message.error('An error occurred during upload.');
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
          pagination={true}
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
