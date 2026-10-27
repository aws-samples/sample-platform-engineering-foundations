import { useState } from 'react';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import CsHeader from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TextFilter from '@cloudscape-design/components/text-filter';
import { ReportList, Report, SectionTitle } from './ReportList';

interface Section {
  name: string;
  icon?: string;
  reports: Report[];
}

interface TwoColumnIndexProps {
  sections: Section[];
}

const PAGE_SIZES = [5, 10, 15];
const DEFAULT_PAGE_SIZE = 5;

function SectionCard({ section, query }: { section: Section; query: string }): JSX.Element {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const reports = section.reports;
  const totalPages = Math.max(1, Math.ceil(reports.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const visible = query ? reports : reports.slice(start, start + pageSize);
  const showPagination = !query && reports.length > pageSize;

  return (
    <Container
      header={<CsHeader variant="h2" counter={`(${reports.length})`}><SectionTitle icon={section.icon}>{section.name}</SectionTitle></CsHeader>}
      footer={showPagination && (
        <SpaceBetween direction="horizontal" size="m" alignItems="center">
          <Pagination
            currentPageIndex={currentPage}
            pagesCount={totalPages}
            onChange={({ detail }) => setPage(detail.currentPageIndex)}
            ariaLabels={{ nextPageLabel: 'Next page', previousPageLabel: 'Previous page', pageLabel: n => `Page ${n}` }}
          />
          <SegmentedControl
            label="Page size"
            selectedId={String(pageSize)}
            onChange={({ detail }) => { setPageSize(Number(detail.selectedId)); setPage(1); }}
            options={PAGE_SIZES.map(size => ({ id: String(size), text: String(size) }))}
          />
        </SpaceBetween>
      )}
    >
      <ReportList reports={visible} ariaLabel={section.name} emptyText={query ? 'No matching reports' : 'No reports yet'} />
    </Container>
  );
}

export function TwoColumnIndex({ sections }: TwoColumnIndexProps): JSX.Element {
  const [search, setSearch] = useState('');
  const query = search.toLowerCase().trim();

  const filteredSections = sections.map(section => ({
    ...section,
    reports: query
      ? section.reports.filter(r =>
          r.name.toLowerCase().includes(query) ||
          (r.description || '').toLowerCase().includes(query) ||
          (r.date || '').toLowerCase().includes(query)
        )
      : section.reports,
  }));

  const totalResults = filteredSections.reduce((sum, s) => sum + s.reports.length, 0);
  const totalReports = sections.reduce((sum, s) => sum + s.reports.length, 0);

  return (
    <div style={{ maxWidth: '1200px', margin: '32px auto', padding: '0 24px' }}>
      <SpaceBetween size="l">
        <TextFilter
          filteringText={search}
          filteringPlaceholder="Search reports..."
          filteringAriaLabel="Search reports"
          countText={query ? `${totalResults} of ${totalReports} reports` : undefined}
          onChange={({ detail }) => setSearch(detail.filteringText)}
        />
        <ColumnLayout columns={filteredSections.length > 1 ? 2 : 1}>
          {filteredSections.map((section) => (
            <SectionCard key={section.name} section={section} query={query} />
          ))}
        </ColumnLayout>
      </SpaceBetween>
    </div>
  );
}
