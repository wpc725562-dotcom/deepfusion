def bubble_sort(arr):
    """对列表进行冒泡排序（升序），返回新列表。"""
    if arr is None:
        return []
    n = len(arr)
    result = arr[:]  # 创建副本，不修改原列表
    for i in range(n):
        swapped = False
        for j in range(0, n - i - 1):
            if result[j] > result[j + 1]:
                result[j], result[j + 1] = result[j + 1], result[j]
                swapped = True
        if not swapped:
            break
    return result
