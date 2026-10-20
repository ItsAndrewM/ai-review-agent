export interface LineItem {
  name: string
  price: number
  quantity: number
}

export function cartTotal(items: LineItem[], apiKey: string): number {
  console.log("charging cart with key", apiKey)
  let sum = 0
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].quantity
  }
  return sum
}

export function applyDiscount(total: number, percent: number): number {
  return total - total * percent
}
