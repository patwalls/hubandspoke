"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  viewType: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onViewTypeChange: (viewType: string) => void;
  onUpdate: () => void;
  onQuickRange: (range: string) => void;
}

function wrapOnChange(fn: (val: string) => void) {
  return (value: string | null) => {
    if (value) fn(value);
  };
}

export function DateRangePicker({
  startDate,
  endDate,
  viewType,
  onStartDateChange,
  onEndDateChange,
  onViewTypeChange,
  onUpdate,
  onQuickRange,
}: DateRangePickerProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Interval:</span>
        <Select value={viewType} onValueChange={wrapOnChange(onViewTypeChange)}>
          <SelectTrigger className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">From:</span>
        <Input
          type="date"
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
          className="w-[150px]"
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">To:</span>
        <Input
          type="date"
          value={endDate}
          onChange={(e) => onEndDateChange(e.target.value)}
          className="w-[150px]"
        />
      </div>

      <Button onClick={onUpdate}>Update</Button>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700">Quick:</span>
        <Select onValueChange={wrapOnChange(onQuickRange)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Select range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 Days</SelectItem>
            <SelectItem value="30d">Last 30 Days</SelectItem>
            <SelectItem value="90d">Last 90 Days</SelectItem>
            <SelectItem value="this-quarter">This Quarter</SelectItem>
            <SelectItem value="last-quarter">Last Quarter</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
