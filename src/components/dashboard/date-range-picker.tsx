"use client";

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
  const quickRanges = [
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "90d", label: "90d" },
    { value: "this-quarter", label: "This Q" },
    { value: "last-quarter", label: "Last Q" },
  ];

  return (
    <div className="space-y-3 sm:space-y-0">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Interval</span>
          <select
            value={viewType}
            onChange={(e) => onViewTypeChange(e.target.value)}
            className="h-9 sm:h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="weekly">Weekly</option>
            <option value="daily">Daily</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">From</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => onStartDateChange(e.target.value)}
            className="h-9 sm:h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">To</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => onEndDateChange(e.target.value)}
            className="h-9 sm:h-8 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <button
          onClick={onUpdate}
          className="h-9 sm:h-8 px-4 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Update
        </button>
      </div>

      <div className="flex items-center gap-1">
        {quickRanges.map((range) => (
          <button
            key={range.value}
            onClick={() => onQuickRange(range.value)}
            className="h-8 sm:h-7 px-3 sm:px-2.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {range.label}
          </button>
        ))}
      </div>
    </div>
  );
}
