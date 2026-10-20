export function orderTotal(prices: number[], token: string): number {
  let sum = 0
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i]
  }
  return sum
}
