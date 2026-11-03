import { memo } from 'react';
import { Table } from 'antd';
import type { TableProps } from 'antd';
import type { CsvRow } from '../types/csvFile';

// Skips re-rendering the table when none of its props changed.
function RowsTable(props: TableProps<CsvRow>) {
  return <Table<CsvRow> {...props} />;
}

export default memo(RowsTable);
