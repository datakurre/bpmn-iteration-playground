export interface WorkflowDataLike {
  document_content?: unknown;
  document_text?: unknown;
  qa_summary?: unknown;
  draft_summary?: unknown;
  agent_output?: { summary?: unknown };
  [key: string]: unknown;
}

// Agent results reach workflow data only via declared outputParameters, so prefer
// the names the templates publish before falling back to legacy implicit keys.
export function withDocumentContentFallback(
  data: WorkflowDataLike | null | undefined,
): Record<string, unknown> {
  const initialData: WorkflowDataLike = data ? { ...data } : {};
  if (!initialData.document_content && data) {
    initialData.document_content =
      data.document_text || data.qa_summary || data.draft_summary || data.agent_output?.summary || initialData.document_content;
  }
  return initialData;
}
