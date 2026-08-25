import unittest
from bubble_sort import bubble_sort


class TestBubbleSort(unittest.TestCase):

    def test_normal_list(self):
        """测试正常无序列表"""
        self.assertEqual(bubble_sort([3, 1, 4, 1, 5, 9, 2, 6]), [1, 1, 2, 3, 4, 5, 6, 9])

    def test_sorted_list(self):
        """测试已排序列表"""
        self.assertEqual(bubble_sort([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5])

    def test_reverse_sorted(self):
        """测试逆序列表"""
        self.assertEqual(bubble_sort([5, 4, 3, 2, 1]), [1, 2, 3, 4, 5])

    def test_empty_list(self):
        """测试空列表"""
        self.assertEqual(bubble_sort([]), [])

    def test_single_element(self):
        """测试单元素列表"""
        self.assertEqual(bubble_sort([42]), [42])

    def test_duplicates(self):
        """测试包含重复元素的列表"""
        self.assertEqual(bubble_sort([3, 3, 3, 1, 2]), [1, 2, 3, 3, 3])

    def test_negative_numbers(self):
        """测试负数列表"""
        self.assertEqual(bubble_sort([-5, -1, -10, 0, 2]), [-10, -5, -1, 0, 2])

    def test_does_not_mutate_input(self):
        """测试不修改原列表"""
        original = [3, 1, 2]
        bubble_sort(original)
        self.assertEqual(original, [3, 1, 2])

    def test_none_input(self):
        """测试 None 输入"""
        self.assertEqual(bubble_sort(None), [])


if __name__ == "__main__":
    unittest.main()
