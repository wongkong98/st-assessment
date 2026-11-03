import { memo, useState } from 'react';
import { Button, DatePicker, Flex, Input } from 'antd';
import type { GetProps } from 'antd';
import type { RowFilters } from '../types/csvFile';

type DateRange = GetProps<typeof DatePicker.RangePicker>['value'];

interface SearchBarProps {
  onSearch: (filters: RowFilters) => void;
}

function SearchBar({ onSearch }: SearchBarProps) {
  const [searchText, setSearchText] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);

  const handleSearch = () => {
    onSearch({
      search: searchText.trim() || undefined,
      from: dateRange?.[0]?.startOf('day').toISOString(),
      to: dateRange?.[1]?.endOf('day').toISOString(),
    });
  };

  return (
    <Flex gap={10} style={{ marginBottom: 10 }}>
      <Input
        placeholder='Search By Name, Body or Email'
        allowClear
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onPressEnter={handleSearch}
      />

      <DatePicker.RangePicker
        allowEmpty={[true, true]}
        value={dateRange}
        onChange={setDateRange}
      />

      <Button type='primary' onClick={handleSearch}>
        Search
      </Button>
    </Flex>
  );
}

export default memo(SearchBar);
