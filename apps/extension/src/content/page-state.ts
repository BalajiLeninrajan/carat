/**
 * What the capture side needs to know from the suggest side of the same
 * page: once a chip has been shown here, this is the page being filled and
 * no screenshot of it may be taken or read. Reset on an in-page navigation.
 */
export interface PageState {
  filling: boolean;
}

export function createPageState(): PageState {
  return { filling: false };
}
