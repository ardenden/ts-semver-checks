export interface Store<TItem> {
  get<TKey>(key: TKey): TItem;
}
