﻿using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Raven.Client.Documents.Indexes;
using Raven.Server.Documents.Queries.Parser;
using Sparrow.Json;

namespace Raven.Server.Documents.Queries
{
    public class QueryMetadata
    {
        private const string CountFieldName = "Count";

        private readonly Dictionary<string, string> _aliasToName = new Dictionary<string, string>();

        public QueryMetadata(string query, BlittableJsonReaderObject parameters)
        {
            var qp = new QueryParser();
            qp.Init(query);
            Query = qp.Parse();

            QueryText = Query.QueryText;

            IsDynamic = Query.From.Index == false;
            IsDistinct = Query.IsDistinct;
            IsGroupBy = Query.GroupBy != null;

            var fromToken = Query.From.From;

            if (IsDynamic)
                CollectionName = QueryExpression.Extract(Query.QueryText, fromToken);
            else
                IndexName = QueryExpression.Extract(Query.QueryText, fromToken);

            Build(parameters);
        }

        public readonly bool IsDistinct;

        public readonly bool IsDynamic;

        public readonly bool IsGroupBy;

        public readonly string CollectionName;

        public readonly string IndexName;

        public readonly Query Query;

        public readonly string QueryText;

        public readonly HashSet<string> IndexFieldNames = new HashSet<string>();

        public readonly Dictionary<string, ValueTokenType> WhereFields = new Dictionary<string, ValueTokenType>(StringComparer.OrdinalIgnoreCase);

        public string[] GroupBy;

        public (string Name, OrderByFieldType OrderingType, bool Ascending)[] OrderBy;

        public SelectField[] SelectFields;

        private void AddExistField(string fieldName)
        {
            IndexFieldNames.Add(GetIndexFieldName(fieldName));
        }

        private void AddWhereField(string fieldName, ValueTokenType value)
        {
            var indexFieldName = GetIndexFieldName(fieldName);

            IndexFieldNames.Add(indexFieldName);
            WhereFields[indexFieldName] = value;
        }

        private void Build(BlittableJsonReaderObject parameters)
        {
            if (Query.GroupBy != null)
            {
                GroupBy = new string[Query.GroupBy.Count];

                for (var i = 0; i < Query.GroupBy.Count; i++)
                    GroupBy[i] = QueryExpression.Extract(Query.QueryText, Query.GroupBy[i]);
            }

            if (Query.Select != null)
                FillSelectFields();
            else
            {
                if (IsGroupBy)
                    throw new InvalidOperationException("Query having GROUP BY needs to have at least one aggregation operation defined in SELECT such as count() or sum()");
            }

            if (Query.Where != null)
                new FillWhereFieldsAndParametersVisitor(this, Query.QueryText).Visit(Query.Where, parameters);

            if (Query.OrderBy != null)
            {
                OrderBy = new(string Name, OrderByFieldType OrderingType, bool Ascending)[Query.OrderBy.Count];

                for (var i = 0; i < Query.OrderBy.Count; i++)
                {
                    var fieldInfo = Query.OrderBy[i];
                    OrderBy[i] = (GetIndexFieldName(QueryExpression.Extract(Query.QueryText, fieldInfo.Field)), fieldInfo.FieldType, fieldInfo.Ascending);
                }
            }
        }

        private void FillSelectFields()
        {
            var fields = new List<SelectField>(Query.Select.Count);

            foreach (var fieldInfo in Query.Select)
            {
                string alias = null;

                if (fieldInfo.Alias != null)
                    alias = QueryExpression.Extract(Query.QueryText, fieldInfo.Alias);

                var expression = fieldInfo.Expression;

                switch (expression.Type)
                {
                    case OperatorType.Field:
                        var name = QueryExpression.Extract(Query.QueryText, expression.Field);
                        fields.Add(SelectField.Create(name, alias));
                        break;
                    case OperatorType.Method:
                        var methodName = QueryExpression.Extract(Query.QueryText, expression.Field);

                        if (IsGroupBy == false)
                            ThrowMethodsAreNotSupportedInSelect(methodName);

                        if (Enum.TryParse(methodName, true, out AggregationOperation aggregation) == false)
                        {
                            switch (methodName)
                            {
                                case "key":
                                    fields.Add(SelectField.CreateGroupByKeyField(alias, GroupBy));
                                    break;
                                default:
                                    ThrowUnknownAggregationMethodInSelectOfGroupByQuery(methodName);
                                    break;
                            }
                        }
                        else
                        {
                            string fieldName = null;

                            switch (aggregation)
                            {
                                case AggregationOperation.Count:
                                    fieldName = CountFieldName;
                                    break;
                                case AggregationOperation.Sum:
                                    if (expression.Arguments == null)
                                        ThrowMissingFieldNameArgumentOfSumMethod();
                                    if (expression.Arguments.Count != 1)
                                        ThrowIncorrectNumberOfArgumentsOfSumMethod(expression.Arguments.Count);

                                    var sumFieldToken = expression.Arguments[0] as FieldToken;

                                    fieldName = QueryExpression.Extract(Query.QueryText, sumFieldToken);
                                    break;
                            }

                            Debug.Assert(fieldName != null);

                            fields.Add(SelectField.CreateGroupByAggregation(fieldName, alias, aggregation));
                        }

                        break;
                    default:
                        ThrowUnhandledExpressionTypeInSelect(expression.Type);
                        break;
                }
            }

            SelectFields = new SelectField[fields.Count];

            for (var i = 0; i < fields.Count; i++)
            {
                var field = fields[i];

                SelectFields[i] = field;

                if (field.Alias != null)
                {
                    if (field.IsGroupByKey == false)
                        _aliasToName[field.Alias] = field.Name;
                    else
                    {
                        if (field.GroupByKeys.Length == 1)
                            _aliasToName[field.Alias] = field.GroupByKeys[0];
                    }
                }
            }
        }

        public string GetIndexFieldName(string fieldNameOrAlias)
        {
            if (_aliasToName.TryGetValue(fieldNameOrAlias, out var indexFieldName))
                return indexFieldName;

            return fieldNameOrAlias;
        }

        private static void ThrowIncompatibleTypesOfVariables(string fieldName, params ValueToken[] valueTokens)
        {
            throw new InvalidOperationException($"Incompatible types of variables in WHERE clause on '{fieldName}' field. It got values of the following types: " +
                                                $"{string.Join(",", valueTokens.Select(x => x.Type.ToString()))}");
        }

        private static void ThrowIncompatibleTypesOfParameters(string fieldName, params ValueToken[] valueTokens)
        {
            throw new InvalidOperationException($"Incompatible types of parameters in WHERE clause on '{fieldName}' field. It got parameters of the following types:   " +
                                                $"{string.Join(",", valueTokens.Select(x => x.Type.ToString()))}");
        }

        private static void ThrowUnknownAggregationMethodInSelectOfGroupByQuery(string methodName)
        {
            throw new NotSupportedException($"Unknown aggregation method in SELECT clause of the group by query: '{methodName}'");
        }

        private static void ThrowMissingFieldNameArgumentOfSumMethod()
        {
            throw new InvalidOperationException("Missing argument of sum() method. You need to specify the name of a field e.g. sum(Age)");
        }

        private static void ThrowIncorrectNumberOfArgumentsOfSumMethod(int count)
        {
            throw new InvalidOperationException($"sum() method expects exactly one argument but got {count}");
        }

        private static void ThrowMethodsAreNotSupportedInSelect(string methodName)
        {
            throw new NotSupportedException($"Method calls are not supported in SELECT clause while you tried to use '{methodName}' method");
        }

        private static void ThrowUnhandledExpressionTypeInSelect(OperatorType expressionType)
        {
            throw new InvalidOperationException($"Unhandled expression of type {expressionType} in SELECT clause");
        }

        private class FillWhereFieldsAndParametersVisitor : WhereExpressionVisitor
        {
            private readonly QueryMetadata _metadata;

            public FillWhereFieldsAndParametersVisitor(QueryMetadata metadata, string queryText) : base(queryText)
            {
                _metadata = metadata;
            }

            public override void VisitFieldToken(string fieldName, ValueToken value, BlittableJsonReaderObject parameters)
            {
                _metadata.AddWhereField(fieldName, GetValueTokenType(parameters, value, unwrapArrays: false));
            }

            public override void VisitFieldTokens(string fieldName, ValueToken firstValue, ValueToken secondValue, BlittableJsonReaderObject parameters)
            {
                if (firstValue.Type != secondValue.Type)
                    ThrowIncompatibleTypesOfVariables(fieldName, firstValue, secondValue);

                var valueType1 = GetValueTokenType(parameters, firstValue, unwrapArrays: false);
                var valueType2 = GetValueTokenType(parameters, secondValue, unwrapArrays: false);

                if (valueType1 != valueType2)
                    ThrowIncompatibleTypesOfParameters(fieldName, firstValue, secondValue);

                _metadata.AddWhereField(fieldName, valueType1);
            }

            public override void VisitFieldTokens(string fieldName, List<ValueToken> values, BlittableJsonReaderObject parameters)
            {
                if (values.Count == 0)
                    return;

                var previousType = ValueTokenType.Null;
                for (var i = 0; i < values.Count; i++)
                {
                    var value = values[i];
                    if (i > 0 && value.Type != values[i - 1].Type)
                        ThrowIncompatibleTypesOfVariables(fieldName, values.ToArray());

                    var valueType = GetValueTokenType(parameters, value, unwrapArrays: true);
                    if (i > 0 && previousType != valueType)
                        ThrowIncompatibleTypesOfParameters(fieldName, values.ToArray());

                    previousType = valueType;
                }

                _metadata.AddWhereField(fieldName, previousType);
            }

            public override void VisitMethodTokens(QueryExpression expression, BlittableJsonReaderObject parameters)
            {
                var arguments = expression.Arguments;
                if (arguments.Count == 0)
                    return;

                string fieldName = null;
                var previousType = ValueTokenType.Null;

                for (var i = 0; i < arguments.Count; i++)
                {
                    var argument = arguments[i];

                    if (argument is QueryExpression expressionArgument)
                    {
                        Visit(expressionArgument, parameters);
                        continue;
                    }

                    if (i == 0)
                    {
                        if (argument is FieldToken fieldTokenArgument)
                            fieldName = QueryExpression.Extract(_metadata.Query.QueryText, fieldTokenArgument);
                        
                        continue;
                    }

                    // validation of parameters

                    var value = (ValueToken)arguments[i];
                    if (i > 1 && value.Type != previousType)
                        ThrowIncompatibleTypesOfVariables(fieldName, arguments.Skip(1).Cast<ValueToken>().ToArray());

                    var valueType = GetValueTokenType(parameters, value, unwrapArrays: false);

                    if (i > 1 && previousType != valueType)
                        ThrowIncompatibleTypesOfParameters(fieldName, arguments.Skip(1).Cast<ValueToken>().ToArray());

                    previousType = valueType;
                }

                if (fieldName == null)
                {
                    // we can have null field name here e.g. boost(search(Tags, :p1), 20), intersect(Age > 20, Name = 'Joe')
                    return;
                }

                if (arguments.Count == 1)
                    _metadata.AddExistField(fieldName); // exists(FieldName)
                else
                    _metadata.AddWhereField(fieldName, previousType);
            }
        }
    }
}