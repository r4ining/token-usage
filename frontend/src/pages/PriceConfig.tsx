import { useEffect, useState } from 'react';
import {
  Button, Card, Form, Input, InputNumber, message, Modal,
  Popconfirm, Radio, Space, Table, Tag, Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { v4 as uuidv4 } from 'uuid';
import { fetchPrices, savePrices } from '../api';
import type { PriceConfig, PriceEntry } from '../types';

const { Text } = Typography;

const emptyConfig: PriceConfig = { entries: [], usd_to_cny: 7.25 };

export default function PriceConfig() {
  const [config, setConfig] = useState<PriceConfig>(emptyConfig);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PriceEntry | null>(null);
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('CNY');
  const [form] = Form.useForm();

  useEffect(() => {
    setLoading(true);
    fetchPrices()
      .then(setConfig)
      .catch(() => message.error('加载价格配置失败'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await savePrices(config);
      message.success('配置已保存');
    } catch {
      message.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const toDisplay = (price: number, entryCurrency: string | undefined): number => {
    const ec = (entryCurrency || 'USD').toUpperCase();
    if (ec === currency) return price;
    const converted = currency === 'CNY' ? price * config.usd_to_cny : price / config.usd_to_cny;
    return Math.round(converted * 1e6) / 1e6;
  };

  const round6 = (n: number) => parseFloat(n.toFixed(6));

  const openEdit = (entry: PriceEntry) => {
    setEditing(entry);
    form.setFieldsValue({
      ...entry,
      aliases: entry.aliases?.join(', ') ?? '',
      input_price: round6(entry.input_price),
      output_price: round6(entry.output_price),
      cache_price: round6(entry.cache_price),
    });
    setModalOpen(true);
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      
      const entry: PriceEntry = {
        id: editing?.id ?? uuidv4(),
        model_id: values.model_id,
        aliases: (values.aliases ?? '')
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean),
        input_price: values.input_price ?? 0,
        output_price: values.output_price ?? 0,
        cache_price: values.cache_price ?? 0,
        currency: currency,
      };
      setConfig(prev => {
        const entries = editing
          ? prev.entries.map(e => (e.id === editing.id ? entry : e))
          : [...prev.entries, entry];
        return { ...prev, entries };
      });
      setModalOpen(false);
    } catch {
      // validation error — do nothing
    }
  };

  const handleDelete = (id: string) => {
    setConfig(prev => ({ ...prev, entries: prev.entries.filter(e => e.id !== id) }));
  };

  const columns: ColumnsType<PriceEntry> = [
    {
      title: '模型 ID',
      dataIndex: 'model_id',
      key: 'model_id',
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '别名（匹配关键词）',
      dataIndex: 'aliases',
      key: 'aliases',
      render: (aliases: string[]) =>
        aliases?.length
          ? aliases.map(a => <Tag key={a}>{a}</Tag>)
          : <Text type="secondary">无</Text>,
    },
    {
      title: `输入价格 (${currency}/1M)`,
      dataIndex: 'input_price',
      key: 'input_price',
      align: 'right',
      render: (v: number, record: PriceEntry) => {
        const symbol = currency === 'CNY' ? '¥' : '$';
        return `${symbol}${toDisplay(v, record.currency).toFixed(6)}`;
      },
    },
    {
      title: `输出价格 (${currency}/1M)`,
      dataIndex: 'output_price',
      key: 'output_price',
      align: 'right',
      render: (v: number, record: PriceEntry) => {
        const symbol = currency === 'CNY' ? '¥' : '$';
        return `${symbol}${toDisplay(v, record.currency).toFixed(6)}`;
      },
    },
    {
      title: `缓存价格 (${currency}/1M)`,
      dataIndex: 'cache_price',
      key: 'cache_price',
      align: 'right',
      render: (v: number, record: PriceEntry) => {
        if (v > 0) {
          const symbol = currency === 'CNY' ? '¥' : '$';
          return `${symbol}${toDisplay(v, record.currency).toFixed(6)}`;
        }
        return <Text type="secondary">同输入价</Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确认删除?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* Global settings */}
      <Card title="全局设置" size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space align="center">
            <Text>价格币种：</Text>
            <Radio.Group 
              value={currency} 
              onChange={(e) => setCurrency(e.target.value)}
              buttonStyle="solid"
            >
              <Radio.Button value="CNY">人民币 (CNY)</Radio.Button>
              <Radio.Button value="USD">美元 (USD)</Radio.Button>
            </Radio.Group>
          </Space>
          <Space align="center">
            <Text>USD → CNY 汇率：</Text>
            <InputNumber
              value={config.usd_to_cny}
              min={0.01}
              step={0.01}
              precision={4}
              style={{ width: 120 }}
              onChange={v => setConfig(prev => ({ ...prev, usd_to_cny: v ?? 7.25 }))}
            />
          </Space>
        </Space>
      </Card>

      {/* Model prices */}
      <Card
        title="模型价格配置"
        size="small"
        extra={
          <Space>
            <Button icon={<PlusOutlined />} onClick={openAdd}>添加模型</Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              保存配置
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          价格单位：{currency === 'CNY' ? 'CNY (人民币)' : 'USD (美元)'} / 每百万 tokens。别名用于匹配 new-api 中记录的模型名称（逗号分隔，含关键词即匹配）。
          {currency === 'CNY' && ' 系统会自动将人民币价格转换为美元存储。'}
        </Typography.Paragraph>
        <Table<PriceEntry>
          dataSource={config.entries}
          columns={columns}
          rowKey="id"
          size="small"
          loading={loading}
          pagination={false}
          locale={{ emptyText: '暂无配置，点击"添加模型"开始' }}
        />
      </Card>

      {/* Add/Edit modal */}
      <Modal
        title={editing ? `编辑模型价格${editing.currency && editing.currency !== currency ? ` （原存储单位: ${editing.currency}，请按 ${currency} 重新填写）` : ''}` : '添加模型价格'}
        open={modalOpen}
        onOk={handleModalOk}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="model_id"
            label="模型 ID"
            rules={[{ required: true, message: '请输入模型 ID' }]}
            extra="精确匹配 new-api logs 表中 model_name 字段"
          >
            <Input placeholder="例如: gpt-4o" />
          </Form.Item>
          <Form.Item
            name="aliases"
            label="别名（匹配关键词，逗号分隔）"
            extra="如果模型名称包含任一别名关键词，则使用此定价。例如: gpt-4o-2024-11-20, gpt-4o-mini"
          >
            <Input placeholder="例如: gpt-4o-2024, gpt4o" />
          </Form.Item>
          <Form.Item 
            name="input_price" 
            label={`输入价格 (${currency} / 百万 tokens)`} 
            rules={[{ required: true }]}
            extra="直接填写当前币种的价格，原样保存"
          >
            <InputNumber 
              min={0} 
              step={currency === 'CNY' ? 0.01 : 0.1} 
              precision={6} 
              style={{ width: '100%' }} 
              placeholder={currency === 'CNY' ? '例如: 8.00' : '例如: 2.5'} 
            />
          </Form.Item>
          <Form.Item 
            name="output_price" 
            label={`输出价格 (${currency} / 百万 tokens)`} 
            rules={[{ required: true }]}
            extra={currency === 'CNY' ? '系统将自动转换为美元存储' : ''}
          >
            <InputNumber 
              min={0} 
              step={currency === 'CNY' ? 0.01 : 0.1} 
              precision={6} 
              style={{ width: '100%' }} 
              placeholder={currency === 'CNY' ? '例如: 28.00' : '例如: 10'} 
            />
          </Form.Item>
          <Form.Item 
            name="cache_price" 
            label={`缓存命中价格 (${currency} / 百万 tokens)`} 
            extra={`留空或 0 表示与输入价格相同${currency === 'CNY' ? '，系统将自动转换为美元存储' : ''}`}
          >
            <InputNumber 
              min={0} 
              step={currency === 'CNY' ? 0.01 : 0.1} 
              precision={6} 
              style={{ width: '100%' }} 
              placeholder={currency === 'CNY' ? '例如: 2.00（留空则同输入价）' : '例如: 0.5（留空则同输入价）'} 
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
