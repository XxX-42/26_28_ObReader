export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type OperationType = "CREATE" | "UPDATE" | "DELETE";

export type AnnotationRecord = {
  id: string;
  kind: string;
  pageIndex: number;
  payload: { [key: string]: JsonValue };
};

export type WalEntry = {
  lsn: number;
  op: OperationType;
  id: string;
  payload?: AnnotationRecord;
  ts: number;
};

export type WalSnapshot = {
  schemaVersion: 1;
  lastLsn: number;
  annotations: AnnotationRecord[];
};
