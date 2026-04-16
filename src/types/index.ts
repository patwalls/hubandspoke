export interface ProductionItem {
  id: string;
  notionId: string | null;
  youtubeId: string | null;
  youtubeUrl: string | null;
  thumbnail: string | null;
  title: string | null;
  publishedDate: string | null;
  status: string | null;
  platform: string[] | null;
  format: string | null;
  brand: string;
  campaign: string | null;
  utmCampaign: string | null;
  publishedLink: string | null;
  isExternal: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  clicks: number | null;
  leads: number | null;
  salesNum: number | null;
  salesAmount: number | null;
  ctrFirstHour: number | null;
  apvFirst24Hours: number | null;
  producerEmail: string | null;
  viewsEstimated: boolean | null;
  lastPerformanceSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Period {
  label: string;
  start: string;
  end: string;
}

export interface MetricData {
  [rowName: string]: {
    [periodLabel: string]: number;
  };
}

export interface ContentReportData {
  periods: Period[];
  byPlatform: {
    production: MetricData;
    views: MetricData;
    leads: MetricData;
    viewsPerPost: MetricData;
    sales: MetricData;
  };
  byFormat: {
    production: MetricData;
    views: MetricData;
    leads: MetricData;
    viewsPerPost: MetricData;
  };
  items: ProductionItem[];
  weekProgress: { day: number; percent: number } | null;
  platforms: string[];
  formats: string[];
  showingFormats: boolean;
}

export interface SyncLog {
  id: string;
  syncType: string;
  status: string;
  itemsFetched: number | null;
  itemsCreated: number | null;
  itemsUpdated: number | null;
  itemsDeleted: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface Format {
  id: string;
  name: string;
  channels: string[];
  event: string | null;
  createdAt: string;
  updatedAt: string;
  repurposeTargets?: Format[];
}
