import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Select, Tooltip, message } from 'antd';
import { DatabaseOutlined } from '@ant-design/icons';
import { fetchDataSource, setDataSource } from '../api';
import type { DataSourceInfo } from '../types';

interface Props {
  size?: 'small' | 'middle' | 'large';
  style?: CSSProperties;
  /** Show the inline "数据源：" label before the select. */
  showLabel?: boolean;
}

/**
 * Runtime log-data-source switcher. When LOG_SQL_DSN is configured the user
 * can switch between the standalone log database and MySQL; otherwise only
 * MySQL is available and the select is disabled.
 */
export default function DataSourceSelect({ size = 'middle', style, showLabel = true }: Props) {
  const [info, setInfo] = useState<DataSourceInfo | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    fetchDataSource()
      .then(setInfo)
      .catch(() => {});
  }, []);

  if (!info) return null;

  const single = info.options.length <= 1;

  const handleChange = async (key: string) => {
    if (key === info.current) return;
    setSwitching(true);
    try {
      await setDataSource(key);
      message.success('数据源已切换，正在刷新…');
      // Reload so every page re-queries against the newly selected source.
      setTimeout(() => window.location.reload(), 400);
    } catch (e: unknown) {
      message.error('切换数据源失败: ' + (e instanceof Error ? e.message : String(e)));
      setSwitching(false);
    }
  };

  const select = (
    <Select
      size={size}
      style={{ width: 200, ...style }}
      value={info.current}
      loading={switching}
      disabled={single}
      onChange={handleChange}
      options={info.options.map(o => ({ label: o.label, value: o.key }))}
    />
  );

  if (!showLabel) return select;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 14, whiteSpace: 'nowrap' }}>
        <DatabaseOutlined style={{ marginRight: 4 }} />
        数据源：
      </span>
      {single ? (
        <Tooltip
          title="未配置 LOG_SQL_DSN，仅有一个数据源（MySQL）"
          mouseEnterDelay={0.2}
          color="rgba(0,0,0,0.78)"
          overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
        >
          {select}
        </Tooltip>
      ) : (
        select
      )}
    </span>
  );
}
