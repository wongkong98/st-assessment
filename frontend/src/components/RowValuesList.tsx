import { Flex, Typography } from 'antd';
import type { CsvRow } from '../types/csvFile';

const DIFF_FIELDS = ['post_id', 'name', 'email', 'body'] as const;

export type RowValues = Pick<CsvRow, typeof DIFF_FIELDS[number]>;

interface RowValuesListProps {
  row: RowValues | null;
  other: RowValues | null;
  highlight: 'danger' | 'success';
}

function RowValuesList({ row, other, highlight }: RowValuesListProps) {
  if (!row) return <Typography.Text type='secondary'>—</Typography.Text>;

  return (
    <Flex vertical gap={2}>
      {DIFF_FIELDS.map((field) => {
        const changed = other !== null && row[field] !== other[field];
        return (
          <div key={field}>
            <Typography.Text type='secondary'>{field}: </Typography.Text>
            <Typography.Text type={changed ? highlight : undefined} strong={changed}>
              {row[field]}
            </Typography.Text>
          </div>
        );
      })}
    </Flex>
  );
}

export default RowValuesList;
