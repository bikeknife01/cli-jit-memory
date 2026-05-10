export function withTimeout(ms, promise, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`timeout: ${label} (${ms}ms)`));
    }, ms);

    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(value);
        }
      },
      error => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    );
  });
}
