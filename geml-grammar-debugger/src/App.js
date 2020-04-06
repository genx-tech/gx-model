import React from 'react';
import 'antd/dist/antd.css';
import { Row, Col } from 'antd';

import TextToParseView from './components/TextToParseView';

function App() {
  return (
    <Row>
      <Col span={12}><TextToParseView /></Col>
      <Col span={12}>col</Col>
    </Row>    
  );
}

export default App;
