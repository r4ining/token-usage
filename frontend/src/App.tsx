import { useState, useEffect } from 'react';
import { Layout, Menu, ConfigProvider, theme } from 'antd';
import { BarChartOutlined, SettingOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import Dashboard from './pages/Dashboard';
import PriceConfig from './pages/PriceConfig';

const { Header, Content, Sider } = Layout;

type PageKey = 'dashboard' | 'prices';

function App() {
  const getPageFromHash = (): PageKey => {
    if (typeof window === 'undefined') return 'dashboard';
    const hash = window.location.hash.slice(1);
    return hash === 'prices' ? 'prices' : 'dashboard';
  };

  const [page, setPage] = useState<PageKey>('dashboard');

  useEffect(() => {
    // Initialize page from hash on mount
    setPage(getPageFromHash());
    
    const handleHashChange = () => {
      setPage(getPageFromHash());
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const updatePage = (newPage: PageKey) => {
    setPage(newPage);
    window.location.hash = newPage === 'prices' ? 'prices' : '';
  };

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', padding: '0 24px', background: '#001529' }}>
          <span style={{ color: '#fff', fontSize: 18, fontWeight: 600, letterSpacing: 1 }}>
            Token 用量查询平台
          </span>
        </Header>
        <Layout>
          <Sider width={200} style={{ background: '#fff' }}>
            <Menu
              mode="inline"
              selectedKeys={[page]}
              style={{ height: '100%', borderRight: 0 }}
              onClick={({ key }) => updatePage(key as PageKey)}
              items={[
                { key: 'dashboard', icon: <BarChartOutlined />, label: '用量统计' },
                { key: 'prices', icon: <SettingOutlined />, label: '价格配置' },
              ]}
            />
          </Sider>
          <Layout style={{ padding: '24px' }}>
            <Content style={{ background: 'transparent', minHeight: 280 }}>
              <div style={{ display: page === 'dashboard' ? 'block' : 'none' }}>
                <Dashboard />
              </div>
              <div style={{ display: page === 'prices' ? 'block' : 'none' }}>
                <PriceConfig />
              </div>
            </Content>
          </Layout>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

export default App;
