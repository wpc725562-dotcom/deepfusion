import unittest
import sys
sys.path.insert(0, '.')
loader = unittest.TestLoader()
tests = loader.discover('.', pattern='test_bubble_sort.py')
runner = unittest.TextTestRunner(verbosity=2)
result = runner.run(tests)
sys.exit(0 if result.wasSuccessful() else 1)
