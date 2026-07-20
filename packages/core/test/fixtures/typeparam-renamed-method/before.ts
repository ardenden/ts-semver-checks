export interface Store<T> {
  get<K>(key: K): T;
}
